// Workshop settings. Edit these to suit, then restart the app.
module.exports = {
  business: {
    name: 'Impact Auto Care',
    phone: '0403 136 074',
    email: 'bookings@impactautocare.com.au',
    location: 'Kembla Grange, NSW',
    website: 'https://impactautocare.com.au',
  },

  // NSW observes AEST in winter and AEDT in summer; this zone handles both.
  timezone: 'Australia/Sydney',

  // 0 = Sunday ... 6 = Saturday. Weekdays only by default.
  openDays: [1, 2, 3, 4, 5],

  // Shown on the booking form.
  hoursText: 'Monday to Friday, 8:00 am to 5:00 pm',

  // Drop-off times customers can pick (24-hour HH:MM, workshop local time).
  dropOffTimes: ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00'],

  // Earliest bookable day (1 = tomorrow) and how far ahead customers can book.
  minDaysAhead: 1,
  maxDaysAhead: 60,

  // Public holidays or shutdown days (YYYY-MM-DD). NSW public holidays to end of 2027;
  // double-check against nsw.gov.au and add your own shutdown days.
  closedDates: [
    '2026-12-25', '2026-12-28',
    '2027-01-01', '2027-01-26', '2027-03-26', '2027-03-29',
    '2027-06-14', '2027-10-04', '2027-12-27', '2027-12-28',
  ],

  services: [
    'Logbook service',
    'General service',
    'Brake repairs',
    'Air conditioning',
    'Transmission repairs',
    'Engine diagnostics / repairs',
    'Pre-purchase inspection',
    'Trailer / caravan service',
    'Other (describe in notes)',
  ],
};
