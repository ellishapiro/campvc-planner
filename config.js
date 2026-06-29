// Camp VC planner - configuration. Edit this file, then re-deploy / refresh.
// Loaded as a plain global (no build step) so the site works on GitHub Pages
// and when opening the .html files directly.
window.CONFIG = {
  // The people planning together. These names appear in the picks dropdown and
  // as the calendar columns. Add up to ~6.
  friends: ["Abs", "Elli", "Jess", "Mummy"],

  // Paste the Google Apps Script web-app URL here after deploying it (see README).
  // Until it's set, the site runs in LOCAL mode: picks are kept in this browser
  // only (localStorage) so you can try everything before wiring up the backend.
  appsScriptUrl: "https://script.google.com/macros/s/AKfycby-vwqPxWtult_bQNDQQq4xeP8ZuAevzfDZvLZShz-vdKtslTexDkfAR3sQUecS31Ykvw/exec",

  // Minimum break between any two booked activities, in minutes. 0 = back-to-back
  // allowed. Raise it to force breathing room everywhere.
  breakMinutes: 0,

  // Extra buffer added before/after off-site activities (the climbing/rafting/
  // canoeing trips), on top of breakMinutes.
  offsiteBufferMinutes: 30,

  // How long to earmark on the calendar for a wanted drop-in activity.
  dropInSlotMinutes: 45,

  // Don't earmark drop-ins before this hour (keeps "all day" drop-ins out of dawn).
  dropInEarliestHour: 9,

  // Togetherness dial: how hard the engine tries to land friends on the SAME
  // instance of a shared activity. A must is never sacrificed for togetherness.
  //   0  = off (everyone gets their own best timetable)
  //   1  = co-locate only when it costs nobody a pick (default)
  //   10 = prefer together (will trade a "want" for one more person sharing)
  //   30 = strongly together
  // Adjustable live in the results page Adjust panel (saved as a shared knob).
  togetherness: 1,

  // Festival open hours (the Main Event Site). Outside these the calendar is
  // greyed out and no drop-ins are earmarked. Empty = no bound that side
  // (it runs continuously overnight in the middle). Friday opens noon (first
  // activities 12:30); Sunday closes 16:30 (last activities 16:00).
  festivalHours: {
    Friday:   { open: "12:00", close: "" },
    Saturday: { open: "",      close: "" },
    Sunday:   { open: "",      close: "16:30" },
  },

  // Fallback calendar bounds (hours) if they can't be derived from the data.
  dayStartHourFallback: 8,
  dayEndHourFallback: 23,
};
