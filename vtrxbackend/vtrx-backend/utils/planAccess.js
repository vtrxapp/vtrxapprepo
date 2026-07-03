// utils/planAccess.js — shared free/Premium plan-generation gate
//
// Free tier gets exactly one active plan (of a given type). Generating a
// replacement while one is already active counts as "regenerating" and
// requires Premium — matches the free-tier pricing copy ("1 training
// programme ... fully personalised").

const canGeneratePlan = async (prismaModel, userId, isPremium) => {
  if (isPremium) return true;
  const existing = await prismaModel.count({ where: { userId, isActive: true } });
  return existing === 0;
};

module.exports = { canGeneratePlan };
