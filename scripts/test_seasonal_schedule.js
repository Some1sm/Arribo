const fs = require('fs');

function testServiceCalendar() {
  const fullSchedule = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_full_schedule.json', 'utf8'));

  const testDates = [
    { label: 'Today (Sunday 16 Aug - Summer Sunday)', date: new Date(2026, 7, 16) },
    { label: 'Winter Sunday (15 Nov)', date: new Date(2026, 10, 15) },
    { label: 'Saturday in Aug (22 Aug)', date: new Date(2026, 7, 22) },
    { label: 'Weekday in Aug (Monday 17 Aug)', date: new Date(2026, 7, 17) },
    { label: 'Weekday in Oct (Wednesday 14 Oct)', date: new Date(2026, 9, 14) }
  ];

  function isServiceActiveOnDate(serviceId, dateObj) {
    const y = dateObj.getFullYear();
    const m = (dateObj.getMonth() + 1).toString().padStart(2, '0');
    const d = dateObj.getDate().toString().padStart(2, '0');
    const mmdd = `${m}${d}`;
    const dayOfWeek = dateObj.getDay();
    const isSunday = dayOfWeek === 0;
    const isSaturday = dayOfWeek === 6;
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    const isAugust = dateObj.getMonth() === 7;

    if (serviceId === 'GEN_184749') return isSunday;
    if (serviceId === 'GEN_185017') return isSunday && (mmdd >= '0615' && mmdd <= '0915');
    if (serviceId === 'GEN_185080') return isSaturday || (isWeekday && isAugust);
    if (serviceId === 'GEN_184910') return isWeekday && !isAugust;
    return false;
  }

  testDates.forEach(td => {
    console.log(`\n=== ${td.label} ===`);
    const activeDir0 = fullSchedule.dir0.filter(t => isServiceActiveOnDate(t.serviceId, td.date));
    const activeDir1 = fullSchedule.dir1.filter(t => isServiceActiveOnDate(t.serviceId, td.date));
    console.log(`Dir 0 (to Barcelona) - ${activeDir0.length} trips:`, activeDir0.map(t => t.stops[0].dep.substring(0, 5)).join(', '));
    console.log(`Dir 1 (to Mataró)     - ${activeDir1.length} trips:`, activeDir1.map(t => t.stops[0].dep.substring(0, 5)).join(', '));
  });
}

testServiceCalendar();
