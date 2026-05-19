// ─────────────────────────────────────────────────────────────────────────────
// src/components/ProgressChart.jsx — Analytics Chart
// ─────────────────────────────────────────────────────────────────────────────
// Uses Chart.js to display workout and calorie trends.
// Fetches real data from the backend.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement,
  LineElement, PointElement, Title, Tooltip,
  Legend, Filler,
} from 'chart.js';
import { Bar, Line } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale, LinearScale, BarElement,
  LineElement, PointElement, Title, Tooltip, Legend, Filler
);

const PRIMARY = '#00A3FF';
const FONT    = 'Montserrat, sans-serif';

// ── Weekly Calories Bar Chart ─────────────────────────────────────────────────
export const CaloriesChart = ({ data = [] }) => {
  const labels = data.map(d => d.day);
  const values = data.map(d => d.calories || 0);

  const chartData = {
    labels,
    datasets: [{
      label:           'Calories Burned',
      data:            values,
      backgroundColor: values.map(v => v > 0 ? `${PRIMARY}cc` : '#333'),
      borderRadius:    6,
      borderSkipped:   false,
    }],
  };

  const options = {
    responsive:          true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) => `${ctx.raw} cal`,
        },
      },
    },
    scales: {
      x: {
        grid:  { display: false },
        ticks: { color: '#888', font: { family: FONT, size: 11 } },
      },
      y: {
        grid:  { color: '#1a1a1a' },
        ticks: { color: '#888', font: { family: FONT, size: 11 } },
        beginAtZero: true,
      },
    },
  };

  return (
    <div style={{ height: 160 }}>
      <Bar data={chartData} options={options}/>
    </div>
  );
};

// ── Streak / Consistency Line Chart ───────────────────────────────────────────
export const ConsistencyChart = ({ data = [] }) => {
  const labels = data.map(d => d.week);
  const values = data.map(d => d.workouts || 0);

  const chartData = {
    labels,
    datasets: [{
      label:           'Workouts per Week',
      data:            values,
      borderColor:     PRIMARY,
      backgroundColor: `${PRIMARY}22`,
      borderWidth:     2.5,
      pointRadius:     4,
      pointBackgroundColor: PRIMARY,
      fill:            true,
      tension:         0.4, // smooth curve
    }],
  };

  const options = {
    responsive:          true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) => `${ctx.raw} workouts`,
        },
      },
    },
    scales: {
      x: {
        grid:  { display: false },
        ticks: { color: '#888', font: { family: FONT, size: 11 } },
      },
      y: {
        grid:  { color: '#1a1a1a' },
        ticks: { color: '#888', font: { family: FONT, size: 11 }, stepSize: 1 },
        beginAtZero: true,
        max: 7,
      },
    },
  };

  return (
    <div style={{ height: 160 }}>
      <Line data={chartData} options={options}/>
    </div>
  );
};
