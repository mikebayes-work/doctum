// scripts/recommended.js — the build-time copy of the default result order
// (netlify/doctum/core.js recommended() is the server copy; keep them the same).
const days = (iso, today) => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 864e5);
const FUND_RANK = { 'Fully funded': 0, 'Competition funded': 1, 'Partially funded': 1 };
function recommended(a, b, today) {
  const late = (r) => (r.deadline && days(r.deadline, today) < 3 ? 1 : 0);
  const fr = (r) => FUND_RANK[r.funding] ?? 2;
  return late(a) - late(b) || fr(a) - fr(b) || (a.deadline || '9999').localeCompare(b.deadline || '9999');
}
module.exports = { recommended };
