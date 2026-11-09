function calculateFee(entryTime, exitTime, firstHourRate, additionalHourRate) {
  const elapsed = new Date(exitTime).getTime() - new Date(entryTime).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error('Invalid parking timestamps');
  const durationMinutes = Math.ceil(elapsed / 60000);
  if (durationMinutes === 0) return { durationMinutes: 0, amount: 0 };
  const extraHours = Math.ceil(Math.max(0, durationMinutes - 60) / 60);
  const amount = Number(firstHourRate) + extraHours * Number(additionalHourRate);
  return { durationMinutes, amount: Number(amount.toFixed(2)) };
}
module.exports = calculateFee;
