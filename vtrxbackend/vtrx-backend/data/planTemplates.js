// ─────────────────────────────────────────────────────────────────────────────
// data/planTemplates.js — Workout week templates
//
// Templates define STRUCTURE only: which muscle groups train on which days.
// They never contain exercises — the plan generator fills those in.
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_TEMPLATES = {

  // ── 3 DAYS PER WEEK — Full Body ────────────────────────────────────────────
  THREE_DAY: {
    weeks: 4,
    sessions_per_week: 3,
    schedule: [
      {
        dayOfWeek: 'Monday',
        sessionName: 'Full Body A',
        muscleGroups: ['chest', 'back', 'legs', 'core'],
        focus: 'push_dominant',
        isRestDay: false,
      },
      {
        dayOfWeek: 'Tuesday',
        sessionName: 'Rest Day',
        isRestDay: true,
      },
      {
        dayOfWeek: 'Wednesday',
        sessionName: 'Full Body B',
        muscleGroups: ['shoulders', 'back', 'legs', 'core'],
        focus: 'pull_dominant',
        isRestDay: false,
      },
      {
        dayOfWeek: 'Thursday',
        sessionName: 'Rest Day',
        isRestDay: true,
      },
      {
        dayOfWeek: 'Friday',
        sessionName: 'Full Body C',
        muscleGroups: ['chest', 'glutes', 'legs', 'core'],
        focus: 'lower_dominant',
        isRestDay: false,
      },
      {
        dayOfWeek: 'Saturday',
        sessionName: 'Rest Day',
        isRestDay: true,
      },
      {
        dayOfWeek: 'Sunday',
        sessionName: 'Rest Day',
        isRestDay: true,
      },
    ],
  },

  // ── 4 DAYS PER WEEK — Upper / Lower Split ──────────────────────────────────
  FOUR_DAY: {
    weeks: 4,
    sessions_per_week: 4,
    schedule: [
      {
        dayOfWeek: 'Monday',
        sessionName: 'Upper Body A',
        muscleGroups: ['chest', 'back', 'shoulders', 'biceps'],
        focus: 'upper_push',
        isRestDay: false,
      },
      {
        dayOfWeek: 'Tuesday',
        sessionName: 'Lower Body A',
        muscleGroups: ['legs', 'glutes', 'core'],
        focus: 'lower',
        isRestDay: false,
      },
      {
        dayOfWeek: 'Wednesday',
        sessionName: 'Rest Day',
        isRestDay: true,
      },
      {
        dayOfWeek: 'Thursday',
        sessionName: 'Upper Body B',
        muscleGroups: ['chest', 'back', 'triceps', 'shoulders'],
        focus: 'upper_pull',
        isRestDay: false,
      },
      {
        dayOfWeek: 'Friday',
        sessionName: 'Lower Body B',
        muscleGroups: ['legs', 'glutes', 'core', 'cardio'],
        focus: 'lower_cardio',
        isRestDay: false,
      },
      {
        dayOfWeek: 'Saturday',
        sessionName: 'Rest Day',
        isRestDay: true,
      },
      {
        dayOfWeek: 'Sunday',
        sessionName: 'Rest Day',
        isRestDay: true,
      },
    ],
  },

  // ── 5 DAYS PER WEEK — Push / Pull / Legs ───────────────────────────────────
  FIVE_DAY: {
    weeks: 4,
    sessions_per_week: 5,
    schedule: [
      {
        dayOfWeek: 'Monday',
        sessionName: 'Push Day',
        muscleGroups: ['chest', 'shoulders', 'triceps'],
        focus: 'push',
        isRestDay: false,
      },
      {
        dayOfWeek: 'Tuesday',
        sessionName: 'Pull Day',
        muscleGroups: ['back', 'biceps'],
        focus: 'pull',
        isRestDay: false,
      },
      {
        dayOfWeek: 'Wednesday',
        sessionName: 'Leg Day',
        muscleGroups: ['legs', 'glutes', 'core'],
        focus: 'legs',
        isRestDay: false,
      },
      {
        dayOfWeek: 'Thursday',
        sessionName: 'Upper Body',
        muscleGroups: ['chest', 'back', 'shoulders'],
        focus: 'upper',
        isRestDay: false,
      },
      {
        dayOfWeek: 'Friday',
        sessionName: 'Lower Body',
        muscleGroups: ['legs', 'glutes', 'cardio'],
        focus: 'lower',
        isRestDay: false,
      },
      {
        dayOfWeek: 'Saturday',
        sessionName: 'Rest Day',
        isRestDay: true,
      },
      {
        dayOfWeek: 'Sunday',
        sessionName: 'Rest Day',
        isRestDay: true,
      },
    ],
  },
};

module.exports = { PLAN_TEMPLATES };
