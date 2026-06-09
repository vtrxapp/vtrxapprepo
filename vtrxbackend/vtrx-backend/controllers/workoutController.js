// ─────────────────────────────────────────────────────────────────────────────
// controllers/workoutController.js — Workout & Logging Controller
// ─────────────────────────────────────────────────────────────────────────────

const prisma    = require('../config/database');
const aiService = require('../services/aiService');
const ymove     = require('../services/ymoveService');
const logger    = require('../utils/logger');

// ── GET /api/workouts — Get available workout programmes ──────────────────────
const getWorkouts = async (req, res) => {
  const { type, difficulty, source = 'all' } = req.query;

  try {
    // Get workouts from our database
    const dbWorkouts = await prisma.workout.findMany({
      where: {
        isPublic: true,
        ...(type       && { type }),
        ...(difficulty && { difficulty }),
      },
      include: {
        exercises: {
          include: { exercise: true },
          orderBy: { order: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Optionally enrich with Ymove content
    let ymoveWorkouts = [];
    if (source === 'ymove' || source === 'all') {
      ymoveWorkouts = (await ymove.getWorkouts({ type, difficulty })).workouts || [];
    }

    res.json({
      success: true,
      data: {
        workouts: [...dbWorkouts, ...ymoveWorkouts],
        total:    dbWorkouts.length + ymoveWorkouts.length,
      },
    });
  } catch (error) {
    logger.error('getWorkouts error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch workouts' });
  }
};

// ── GET /api/workouts/:id — Get single workout ────────────────────────────────
const getWorkoutById = async (req, res) => {
  const { id } = req.params;

  try {
    const workout = await prisma.workout.findUnique({
      where: { id },
      include: {
        exercises: {
          include: { exercise: true },
          orderBy: { order: 'asc' },
        },
      },
    });

    if (!workout) {
      return res.status(404).json({ success: false, message: 'Workout not found' });
    }

    // If workout has a Ymove ID, try to get video URLs
    if (workout.ymoveId) {
      const ymoveData = await ymove.getWorkoutById(workout.ymoveId);
      if (ymoveData) {
        workout.ymoveData = ymoveData;
      }
    }

    res.json({ success: true, data: { workout } });
  } catch (error) {
    logger.error('getWorkoutById error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch workout' });
  }
};

// ── POST /api/workouts/log — Log a completed workout ─────────────────────────
const logWorkout = async (req, res) => {
  const {
    workoutId,
    name,
    type,
    duration,
    caloriesBurned,
    volume,
    notes,
    exercises,           // [{ exerciseId, name, sets: [{ setNumber, reps, weight }] }]
    generateAI,
    energyLevel,
    completionPercentage, // 0-100
  } = req.body;

  try {
    // 1. Create the workout log
    const workoutLog = await prisma.workoutLog.create({
      data: {
        userId:               req.user.id,
        workoutId:            workoutId || null,
        name,
        type,
        duration:             parseInt(duration),
        caloriesBurned:       caloriesBurned ? parseInt(caloriesBurned) : null,
        volume:               volume ? parseFloat(volume) : null,
        notes,
        energyLevel:          energyLevel || null,
        completionPercentage: completionPercentage != null ? parseInt(completionPercentage) : null,
        sets: {
          create: exercises?.flatMap(ex =>
            (ex.sets || []).map(set => ({
              exerciseId: ex.exerciseId,
              setNumber:  set.setNumber,
              reps:       set.reps    ? parseInt(set.reps)    : null,
              weight:     set.weight  ? parseFloat(set.weight) : null,
              duration:   set.duration ? parseInt(set.duration) : null,
              completed:  set.completed !== false,
            }))
          ) || [],
        },
      },
      include: { sets: true },
    });

    // 2. Update user streak
    await updateStreak(req.user.id);

    // 3. Detect personal records
    const newPRs = [];
    if (exercises?.length) {
      for (const ex of exercises) {
        if (!ex.name) continue;
        for (const set of (ex.sets || [])) {
          const weight = set.weight ? parseFloat(set.weight) : null;
          const reps   = set.reps   ? parseInt(set.reps)    : null;
          if (!weight || weight <= 0) continue;

          const existing = await prisma.personalRecord.findFirst({
            where:   { userId: req.user.id, exerciseName: ex.name },
            orderBy: { weight: 'desc' },
          });

          if (!existing || weight > (existing.weight || 0)) {
            if (existing) {
              await prisma.personalRecord.update({
                where: { id: existing.id },
                data:  { weight, reps, achievedAt: new Date() },
              });
            } else {
              await prisma.personalRecord.create({
                data: { userId: req.user.id, exerciseName: ex.name, weight, reps },
              });
            }
            newPRs.push({ exerciseName: ex.name, weight, reps, isFirstRecord: !existing });
          }
        }
      }
    }

    // 4. Generate AI summary asynchronously
    if (generateAI !== false) {
      generateAndSaveAISummary({
        workoutLogId:  workoutLog.id,
        workoutName:   name,
        workoutType:   type,
        duration,
        caloriesBurned,
        exercises,
        energyLevel,
        userGoal:      req.user.goal,
        streakDays:    req.user.streakDays,
      }).catch(err => logger.error('AI summary generation failed:', err));
    }

    logger.info(`Workout logged: ${name} by user ${req.user.id} (${completionPercentage ?? 100}% complete)`);

    res.status(201).json({
      success: true,
      message: 'Workout logged successfully!',
      data:    { workoutLog, newPRs },
    });

  } catch (error) {
    logger.error('logWorkout error:', error);
    res.status(500).json({ success: false, message: 'Failed to log workout' });
  }
};

// ── GET /api/workouts/history — User's workout history ───────────────────────
const getWorkoutHistory = async (req, res) => {
  const { limit = 20, offset = 0, type } = req.query;

  try {
    const [logs, total] = await Promise.all([
      prisma.workoutLog.findMany({
        where: {
          userId: req.user.id,
          ...(type && { type }),
        },
        include: {
          aiSummary: { select: { summary: true } },
          _count:    { select: { sets: true } },
        },
        orderBy: { completedAt: 'desc' },
        take:    parseInt(limit),
        skip:    parseInt(offset),
      }),
      prisma.workoutLog.count({ where: { userId: req.user.id } }),
    ]);

    res.json({
      success: true,
      data:    { logs, total, hasMore: parseInt(offset) + parseInt(limit) < total },
    });
  } catch (error) {
    logger.error('getWorkoutHistory error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch history' });
  }
};

// ── GET /api/workouts/ai-summary/:logId — Get AI summary for a workout ────────
const getAISummary = async (req, res) => {
  const { logId } = req.params;

  try {
    const summary = await prisma.aISummary.findUnique({
      where: { workoutLogId: logId },
    });

    // If summary isn't ready yet, return a 202 (accepted, processing)
    if (!summary) {
      return res.status(202).json({
        success: false,
        message: 'AI summary is being generated. Try again in a moment.',
        code:    'SUMMARY_PENDING',
      });
    }

    res.json({ success: true, data: { summary } });
  } catch (error) {
    logger.error('getAISummary error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch AI summary' });
  }
};

// ── HELPER: Update user's streak ─────────────────────────────────────────────
const updateStreak = async (userId) => {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { lastActiveAt: true, streakDays: true },
  });

  const now       = new Date();
  const lastActive = user.lastActiveAt;
  let newStreak   = user.streakDays || 0;

  if (lastActive) {
    const hoursSinceLastActive = (now - lastActive) / (1000 * 60 * 60);

    if (hoursSinceLastActive < 48) {
      // Within 48 hours — extend streak
      const daysSinceLastActive = Math.floor(hoursSinceLastActive / 24);
      if (daysSinceLastActive >= 1) newStreak += 1;
    } else {
      // More than 48 hours — streak broken
      newStreak = 1;
    }
  } else {
    newStreak = 1;
  }

  await prisma.user.update({
    where: { id: userId },
    data:  { streakDays: newStreak, lastActiveAt: now },
  });
};

// ── HELPER: Generate and save AI summary ─────────────────────────────────────
const generateAndSaveAISummary = async ({
  workoutLogId,
  workoutName,
  workoutType,
  duration,
  caloriesBurned,
  exercises,
  energyLevel,
  userGoal,
  streakDays,
}) => {
  const { summary, keyInsights, recommendations, tokensUsed, model } = await aiService.generateWorkoutSummary({
    workoutName,
    workoutType,
    duration,
    caloriesBurned,
    exercises,
    energyLevel,
    userGoal,
    streakDays,
  });

  await prisma.aISummary.create({
    data: {
      workoutLogId,
      summary,
      keyInsights:     keyInsights     || [],
      recommendations: recommendations || [],
      energyKey:       energyLevel,
      model,
      tokensUsed,
    },
  });
};

// ── GET /api/workouts/stats — Weekly + monthly stats ─────────────────────────
const getWeeklyStats = async (req, res) => {
  const now     = new Date();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Start of current month
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  // Start of current week (Monday)
  const dayOfWeek  = now.getDay() === 0 ? 6 : now.getDay() - 1; // Mon=0
  const weekStart  = new Date(now); weekStart.setDate(now.getDate() - dayOfWeek); weekStart.setHours(0,0,0,0);

  try {
    const [weekLogs, monthLogs, totalCount, userRow] = await Promise.all([
      prisma.workoutLog.findMany({
        where: { userId: req.user.id, completedAt: { gte: weekStart } },
        select: { duration: true, caloriesBurned: true, type: true, completedAt: true, name: true },
        orderBy: { completedAt: 'asc' },
      }),
      prisma.workoutLog.findMany({
        where: { userId: req.user.id, completedAt: { gte: monthStart } },
        select: { completedAt: true, type: true, caloriesBurned: true },
      }),
      prisma.workoutLog.count({ where: { userId: req.user.id } }),
      prisma.user.findUnique({ where: { id: req.user.id }, select: { streakDays: true, daysPerWeek: true } }),
    ]);

    const DAY_NAMES = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

    // Build daily breakdown for current week (Mon–Sun)
    const dailyBreakdown = DAY_NAMES.map(day => ({ day, cal: 0, type: 'rest' }));
    for (const log of weekLogs) {
      const d   = new Date(log.completedAt);
      const idx = d.getDay() === 0 ? 6 : d.getDay() - 1; // Mon=0
      dailyBreakdown[idx] = {
        day:  DAY_NAMES[idx],
        cal:  log.caloriesBurned || 0,
        type: (log.type || 'strength').toLowerCase(),
      };
    }

    // Monthly completed days (unique dates)
    const completedDates = [...new Set(monthLogs.map(l =>
      new Date(l.completedAt).toISOString().slice(0, 10)
    ))];

    const stats = {
      workoutsCompleted: weekLogs.length,
      totalMinutes:      weekLogs.reduce((s, l) => s + l.duration, 0),
      totalCalories:     weekLogs.reduce((s, l) => s + (l.caloriesBurned || 0), 0),
      avgCalories:       weekLogs.length
        ? Math.round(weekLogs.reduce((s, l) => s + (l.caloriesBurned || 0), 0) / weekLogs.length)
        : 0,
      avgMinutes:        weekLogs.length
        ? Math.round(weekLogs.reduce((s, l) => s + l.duration, 0) / weekLogs.length)
        : 0,
      byType: weekLogs.reduce((acc, l) => {
        acc[l.type] = (acc[l.type] || 0) + 1;
        return acc;
      }, {}),
      dailyBreakdown,
      monthlyCompletedDays: completedDates.length,
      monthlyCompletedDates: completedDates,
      currentStreak:   userRow?.streakDays    || 0,
      daysPerWeek:     userRow?.daysPerWeek   || 3,
      totalWorkouts:   totalCount,
    };

    res.json({ success: true, data: { stats } });
  } catch (error) {
    logger.error('getWeeklyStats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
};

// ── Energy-level adaptation matrix ───────────────────────────────────────────
const ENERGY_ADAPTATION = {
  empty: {
    label:          'Recovery Day',
    description:    'Low energy detected — switching to a gentle recovery session.',
    durationFactor: 0.5,
    intensityLock:  'Beginner',
    preferredTypes: ['RECOVERY', 'MOBILITY'],
  },
  low: {
    label:          'Reduced Intensity',
    description:    'Low energy — shorter duration and reduced intensity.',
    durationFactor: 0.7,
    intensityLock:  null,
    preferredTypes: ['CARDIO', 'MOBILITY'],
  },
  okay: {
    label:          'Standard Workout',
    description:    'Normal energy — full workout as planned.',
    durationFactor: 1.0,
    intensityLock:  null,
    preferredTypes: null,
  },
  good: {
    label:          'Full Intensity',
    description:    'Good energy — pushing to full effort today.',
    durationFactor: 1.0,
    intensityLock:  null,
    preferredTypes: null,
  },
  peak: {
    label:          'Max Performance',
    description:    'Peak energy — high-intensity session unlocked.',
    durationFactor: 1.2,
    intensityLock:  null,
    preferredTypes: ['HIIT', 'STRENGTH'],
  },
};

// ── GET /api/workouts/recommend — Personalised workout recommendation ─────────
const getRecommendation = async (req, res) => {
  const { energyLevel = 'okay' } = req.query;
  const user = req.user;

  try {
    const adaptation = ENERGY_ADAPTATION[energyLevel] || ENERGY_ADAPTATION.okay;
    const goal       = (user.goal || 'general fitness').toLowerCase();
    const level      = user.fitnessLevel || 'Intermediate';
    const equipment  = user.equipment    || [];
    const location   = user.location     || 'Full Gym';
    const daysPerWeek = user.daysPerWeek || 3;

    // ── Determine preferred workout type from goal ──────────────────────────
    let workoutType = 'STRENGTH';
    if (goal.includes('weight') || goal.includes('fat') || goal.includes('loss')) workoutType = 'HIIT';
    else if (goal.includes('cardio') || goal.includes('endurance'))               workoutType = 'CARDIO';
    else if (goal.includes('mobility') || goal.includes('flex'))                  workoutType = 'MOBILITY';

    // Energy adaptation overrides type
    if (adaptation.preferredTypes) workoutType = adaptation.preferredTypes[0];

    const targetDuration = Math.round(
      (user.workoutTime
        ? parseInt((user.workoutTime || '45').match(/\d+/)?.[0]) || 45
        : 45) * adaptation.durationFactor
    );

    const difficulty = adaptation.intensityLock || level;

    // ── Find all matching workouts, then pick one by energy level for variety ──
    const allMatching = await prisma.workout.findMany({
      where: { isPublic: true, type: workoutType },
      include: {
        exercises: {
          include:  { exercise: true },
          orderBy:  { order: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    });

    // Each energy level picks a different workout index so exercises visibly change
    const ENERGY_PICK = { empty: 0, low: 0, okay: 0, good: 1, peak: 2 };
    const pickIdx = ENERGY_PICK[energyLevel] ?? 0;
    const dbWorkout = allMatching[Math.min(pickIdx, Math.max(allMatching.length - 1, 0))] || allMatching[0] || null;

    // ── Build recommendation object ─────────────────────────────────────────
    const recommendation = dbWorkout
      ? {
          source:       'database',
          workoutId:    dbWorkout.id,
          name:         dbWorkout.name,
          type:         dbWorkout.type,
          duration:     targetDuration,
          calories:     dbWorkout.calories || Math.round(targetDuration * 7),
          difficulty:   dbWorkout.difficulty,
          description:  dbWorkout.description,
          imageUrl:     dbWorkout.imageUrl,
          exercises:    await (async () => {
            const MIN_VIDEOS = 5;
            const linked = dbWorkout.exercises
              .filter(we => we.exercise.videoUrl)
              .map(we => ({
                id:           we.exercise.id,
                name:         we.exercise.name,
                muscleGroup:  we.exercise.muscleGroup,
                equipment:    we.exercise.equipment,
                sets:         we.sets,
                reps:         we.reps,
                restSecs:     we.restSecs,
                videoUrl:     we.exercise.videoUrl,
                ymoveId:      we.exercise.ymoveId,
                thumbnailUrl: we.exercise.thumbnailUrl,
              }));

            // Pad to MIN_VIDEOS using exercises from the same muscle groups
            if (linked.length < MIN_VIDEOS) {
              const linkedIds    = linked.map(e => e.id);
              const muscleGroups = [...new Set(linked.map(e => e.muscleGroup).filter(Boolean))];
              const need         = MIN_VIDEOS - linked.length;

              // First try muscle-group-specific exercises for relevant padding
              let extra = await prisma.exercise.findMany({
                where: {
                  videoUrl:    { not: null },
                  id:          { notIn: linkedIds },
                  ...(muscleGroups.length > 0 && { muscleGroup: { in: muscleGroups } }),
                },
                take:    need,
                orderBy: { name: 'asc' },
              });

              // Fall back to any exercise if not enough muscle-group matches
              if (extra.length < need) {
                const fallback = await prisma.exercise.findMany({
                  where: { videoUrl: { not: null }, id: { notIn: [...linkedIds, ...extra.map(e => e.id)] } },
                  take:    need - extra.length,
                  orderBy: { name: 'asc' },
                });
                extra = [...extra, ...fallback];
              }

              extra.forEach(e => linked.push({
                id: e.id, name: e.name, muscleGroup: e.muscleGroup,
                equipment: e.equipment, sets: 3, reps: '10', restSecs: 60,
                videoUrl: e.videoUrl, ymoveId: e.ymoveId, thumbnailUrl: e.thumbnailUrl,
              }));
            }

            // Refresh thumbnailUrls from ymove — stored URLs expire after 48 h
            const refreshed = await Promise.allSettled(
              linked.map(async (ex) => {
                if (!ex.ymoveId) return ex;
                try {
                  const fresh = await ymove.getExerciseById(ex.ymoveId);
                  if (fresh) {
                    return {
                      ...ex,
                      thumbnailUrl: fresh.thumbnail_url || fresh.thumbnailUrl || fresh.gif_url || ex.thumbnailUrl,
                      videoUrl:     fresh.video_url     || fresh.videoUrl     || ex.videoUrl,
                    };
                  }
                } catch (_) {}
                return ex;
              })
            );

            return refreshed.map((r, i) => r.status === 'fulfilled' ? r.value : linked[i]);
          })(),
        }
      : {
          source:      'generated',
          name:        buildWorkoutName(workoutType, level, energyLevel),
          type:        workoutType,
          duration:    targetDuration,
          calories:    Math.round(targetDuration * 7),
          difficulty:  difficulty,
          description: adaptation.description,
          exercises:   [],
        };

    // ── Build alternatives for each energy swap ─────────────────────────────
    const alternativeTypes = {
      machine:  'STRENGTH',
      short:    'CARDIO',
      mobility: 'MOBILITY',
      recovery: 'RECOVERY',
    };

    const alternatives = await Promise.all(
      Object.entries(alternativeTypes).map(async ([key, type]) => {
        const alt = await prisma.workout.findFirst({
          where: { isPublic: true, type },
          select: { id: true, name: true, type: true, duration: true, calories: true, difficulty: true },
        });
        return alt
          ? { ...alt, swapReason: key, duration: Math.round(alt.duration * adaptation.durationFactor) }
          : null;
      })
    );

    res.json({
      success: true,
      data: {
        recommendation,
        energyAdaptation: {
          level:       energyLevel,
          label:       adaptation.label,
          description: adaptation.description,
        },
        userContext: {
          goal:       user.goal,
          level:      user.fitnessLevel,
          equipment,
          location,
          daysPerWeek,
        },
        alternatives: alternatives.filter(Boolean),
      },
    });
  } catch (error) {
    logger.error('getRecommendation error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate recommendation' });
  }
};

const buildWorkoutName = (type, level, energy) => {
  const prefix = energy === 'empty' ? 'Recovery' : energy === 'peak' ? 'Power' : '';
  const names = {
    STRENGTH: `${prefix} Strength Session`.trim(),
    HIIT:     `${prefix} HIIT Circuit`.trim(),
    CARDIO:   `${prefix} Cardio Burn`.trim(),
    MOBILITY: 'Mobility & Stretch Flow',
    RECOVERY: 'Active Recovery Session',
  };
  return names[type] || 'Custom Workout';
};

// ── POST /api/workouts/video-progress — Save video watch position ─────────────
const saveVideoProgress = async (req, res) => {
  const { ymoveId, exerciseId, positionSecs, durationSecs, completed } = req.body;

  if (!ymoveId && !exerciseId) {
    return res.status(400).json({ success: false, message: 'ymoveId or exerciseId required' });
  }

  try {
    const progress = await prisma.videoProgress.upsert({
      where: ymoveId
        ? { userId_ymoveId: { userId: req.user.id, ymoveId } }
        : { userId_ymoveId: { userId: req.user.id, ymoveId: exerciseId } },
      update: {
        positionSecs: positionSecs ?? 0,
        durationSecs: durationSecs ?? null,
        completed:    completed    ?? false,
      },
      create: {
        userId:      req.user.id,
        ymoveId:     ymoveId || exerciseId,
        exerciseId:  exerciseId || null,
        positionSecs: positionSecs ?? 0,
        durationSecs: durationSecs ?? null,
        completed:    completed    ?? false,
      },
    });
    res.json({ success: true, data: { progress } });
  } catch (error) {
    logger.error('saveVideoProgress error:', error);
    res.status(500).json({ success: false, message: 'Failed to save progress' });
  }
};

// ── GET /api/workouts/video-progress — Get video progress for exercises ────────
const getVideoProgress = async (req, res) => {
  const { ids } = req.query; // comma-separated ymove IDs

  try {
    const ymoveIds = ids ? ids.split(',').filter(Boolean) : [];

    const progressRecords = await prisma.videoProgress.findMany({
      where: {
        userId:  req.user.id,
        ...(ymoveIds.length > 0 && { ymoveId: { in: ymoveIds } }),
      },
    });

    const progressMap = progressRecords.reduce((acc, p) => {
      if (p.ymoveId) acc[p.ymoveId] = p;
      return acc;
    }, {});

    res.json({ success: true, data: { progress: progressMap } });
  } catch (error) {
    logger.error('getVideoProgress error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch progress' });
  }
};

// ── GET /api/workouts/upcoming — Next N days with energy predictions ───────────
const getUpcomingWorkouts = async (req, res) => {
  const daysNum = Math.min(parseInt(req.query.days || '4'), 7);

  // Energy prediction cycle: after heavy sessions energy dips, then recovers
  const ENERGY_CYCLE = ['good', 'okay', 'peak', 'low', 'good', 'okay', 'peak'];

  try {
    const availableWorkouts = await prisma.workout.findMany({
      where: { isPublic: true },
      include: {
        exercises: {
          where:   { exercise: { videoUrl: { not: null } } },
          include: { exercise: true },
          orderBy: { order: 'asc' },
          take: 12,
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (!availableWorkouts.length) {
      return res.json({ success: true, data: { upcoming: [] } });
    }

    const today      = new Date();
    const DAY_NAMES  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

    const upcoming = Array.from({ length: daysNum }, (_, i) => {
      const date           = new Date(today);
      date.setDate(today.getDate() + i + 1);
      const predictedEnergy = ENERGY_CYCLE[i % ENERGY_CYCLE.length];
      const adaptation      = ENERGY_ADAPTATION[predictedEnergy] || ENERGY_ADAPTATION.okay;
      const workout         = availableWorkouts[i % availableWorkouts.length];

      return {
        date:           date.toISOString().slice(0, 10),
        dayName:        DAY_NAMES[date.getDay()],
        predictedEnergy,
        energyLabel:    adaptation.label,
        workout: {
          id:         workout.id,
          name:       workout.name,
          type:       workout.type,
          duration:   Math.round(workout.duration * adaptation.durationFactor),
          calories:   Math.round(workout.calories * adaptation.durationFactor),
          difficulty: workout.difficulty,
          exercises:  workout.exercises.slice(0, 6).map(we => ({
            name: we.exercise.name,
            sets: we.sets,
            reps: we.reps,
          })),
        },
      };
    });

    res.json({ success: true, data: { upcoming } });
  } catch (error) {
    logger.error('getUpcomingWorkouts error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch upcoming workouts' });
  }
};

// ── GET /api/workouts/exercise-video/:ymoveId — Fresh video URL proxy ─────────
const getExerciseVideoUrl = async (req, res) => {
  const { ymoveId } = req.params;
  try {
    const url = await ymove.getExerciseVideoUrl(ymoveId);
    if (!url) {
      return res.status(404).json({ success: false, message: 'Video not available' });
    }
    res.json({ success: true, data: { videoUrl: url, expiresIn: 48 * 3600 } });
  } catch (error) {
    logger.error('getExerciseVideoUrl error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch video URL' });
  }
};

module.exports = {
  getWorkouts,
  getWorkoutById,
  logWorkout,
  getWorkoutHistory,
  getAISummary,
  getWeeklyStats,
  getRecommendation,
  saveVideoProgress,
  getVideoProgress,
  getExerciseVideoUrl,
  getUpcomingWorkouts,
};
