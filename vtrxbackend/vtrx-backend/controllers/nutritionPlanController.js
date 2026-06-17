// ─────────────────────────────────────────────────────────────────────────────
// controllers/nutritionPlanController.js — AI Nutrition Plan Management
// ─────────────────────────────────────────────────────────────────────────────

const prisma   = require('../config/database');
const logger   = require('../utils/logger');
const planSvc  = require('../services/nutritionPlanService');

// ── POST /api/nutrition/generate-plan ────────────────────────────────────────
const generateNutritionPlan = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: {
        id: true, name: true, gender: true, age: true,
        weight: true, height: true,
        goal: true, fitnessLevel: true, daysPerWeek: true,
        nutritionGoal: true, trackingPreference: true,
        dietaryRestrictions: true, mealsPerDay: true,
        wantsMealSuggestions: true,
        bodyFatPercentage: true, goalWeightLbs: true,
      },
    });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { plan, calcs } = await planSvc.generateNutritionPlan(user);

    // Deactivate existing active plans
    await prisma.nutritionPlan.updateMany({
      where: { userId: req.user.id, isActive: true },
      data:  { isActive: false },
    });

    // Save new plan
    const saved = await prisma.nutritionPlan.create({
      data: {
        userId:        req.user.id,
        planJson:      plan,
        calorieTarget: calcs.calorieTarget,
        proteinTargetG: calcs.proteinG,
        isActive:      true,
        weekNumber:    1,
      },
    });

    // Persist calculated targets back to user profile
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        calculatedBmr:       calcs.bmr,
        calculatedTdee:      calcs.tdee,
        dailyCalorieTarget:  calcs.calorieTarget,
        dailyProteinTargetG: calcs.proteinG,
        dailyCarbTargetG:    calcs.carbG,
        dailyFatTargetG:     calcs.fatG,
      },
    });

    res.json({ success: true, data: { plan, planId: saved.id, calcs } });
  } catch (err) { next(err); }
};

// ── GET /api/nutrition/active-plan ───────────────────────────────────────────
const getActiveNutritionPlan = async (req, res, next) => {
  try {
    const record = await prisma.nutritionPlan.findFirst({
      where:   { userId: req.user.id, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!record) return res.json({ success: true, data: { plan: null } });

    res.json({
      success: true,
      data: {
        plan:      record.planJson,
        planId:    record.id,
        createdAt: record.createdAt,
      },
    });
  } catch (err) { next(err); }
};

// ── POST /api/nutrition/food-log ─────────────────────────────────────────────
const logFood = async (req, res, next) => {
  const { mealName, recipeName, calories, proteinG, carbsG, fatG, fromPlan = false } = req.body;
  if (!mealName || !recipeName) {
    return res.status(400).json({ success: false, message: 'mealName and recipeName required' });
  }
  try {
    const log = await prisma.foodLog.create({
      data: {
        userId:     req.user.id,
        mealName:   String(mealName),
        recipeName: String(recipeName),
        calories:   parseFloat(calories)  || 0,
        proteinG:   parseFloat(proteinG)  || 0,
        carbsG:     parseFloat(carbsG)    || 0,
        fatG:       parseFloat(fatG)      || 0,
        fromPlan:   Boolean(fromPlan),
      },
    });
    res.status(201).json({ success: true, data: { log } });
  } catch (err) { next(err); }
};

// ── GET /api/nutrition/food-log/today ────────────────────────────────────────
const getTodayFoodLogs = async (req, res, next) => {
  try {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end   = new Date(); end.setHours(23, 59, 59, 999);
    const logs  = await prisma.foodLog.findMany({
      where:   { userId: req.user.id, loggedAt: { gte: start, lte: end } },
      orderBy: { loggedAt: 'asc' },
    });
    const totals = logs.reduce((acc, l) => ({
      calories: acc.calories + (l.calories || 0),
      proteinG: acc.proteinG + (l.proteinG || 0),
      carbsG:   acc.carbsG   + (l.carbsG   || 0),
      fatG:     acc.fatG     + (l.fatG     || 0),
    }), { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 });

    res.json({ success: true, data: { logs, totals } });
  } catch (err) { next(err); }
};

module.exports = { generateNutritionPlan, getActiveNutritionPlan, logFood, getTodayFoodLogs };
