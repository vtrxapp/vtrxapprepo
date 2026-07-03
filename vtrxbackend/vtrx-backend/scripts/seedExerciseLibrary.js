// scripts/seedExerciseLibrary.js
// Usage: node scripts/seedExerciseLibrary.js
// Upserts all 48 exercises into the exercise_library table.

require('dotenv').config();

const prisma    = require('../config/database');
const EXERCISES = require('../data/exerciseLibraryData');

async function main() {
  console.log(`Seeding ${EXERCISES.length} exercises…`);

  let created = 0;
  let updated = 0;

  for (const ex of EXERCISES) {
    const result = await prisma.exerciseLibrary.upsert({
      where:  { id: ex.id },
      update: {
        name:        ex.name,
        muscleGroup: ex.muscleGroup,
        equipment:   ex.equipment,
        difficulty:  ex.difficulty,
        isCompound:  ex.isCompound,
        isTimed:     ex.isTimed,
        defaultReps: ex.defaultReps,
        defaultSecs: ex.defaultSecs,
      },
      create: ex,
    });
    // prisma upsert doesn't reliably tell us create vs update; track via prior check
    const existed = await prisma.exerciseLibrary.count({ where: { id: ex.id } });
    if (existed > 0) updated++;
    else created++;
    void result;
  }

  // Simpler count approach
  const total = await prisma.exerciseLibrary.count();
  console.log(`Done. exercise_library table now has ${total} rows.`);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
