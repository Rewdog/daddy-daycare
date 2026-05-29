// schedule.config.example.js — Generic schedule template.
// Copy this file to schedule.config.js and customize for your family.
// Set window.SCHEDULE_CONFIG before app.js loads (included first in index.html).
// schedule.config.js is gitignored so your family's data stays private.

window.SCHEDULE_CONFIG = {

  // Named week ranges shown in the dashboard header (optional).
  // Each entry: { start:[YYYY,M,D], end:[YYYY,M,D], emoji, label, note }
  weekRanges: [
    { start:[2026,6,2],  end:[2026,6,6],  emoji:"🚀", label:"Week 1", note:"First week!" },
    { start:[2026,6,9],  end:[2026,6,13], emoji:"✅", label:"Week 2",  note:"Keep it going" },
    // Add more weeks here...
  ],

  // Day-of-week themes (0=Sun, 1=Mon, ..., 5=Fri, 6=Sat).
  // Each entry: { name, emoji, color, morning, afternoon, chores: [choreId, ...] }
  dayThemes: {
    1: { name:"Family Day",         emoji:"👨‍👩‍👧‍👦", color:"#e8f5e9", morning:"Activity with a parent or fun family hangout",    afternoon:"Lighter family time",              chores:["be-kind-sibling","play-together-1hr"] },
    2: { name:"STEM & Making",      emoji:"🔭",       color:"#e3f2fd", morning:"Science experiments, building, or coding",        afternoon:"Tech project continuation",         chores:["creative-project","morning-workout"] },
    3: { name:"Creative Day",       emoji:"🎨",       color:"#fce4ec", morning:"Art, drawing, baking, or craft project",           afternoon:"Free creative time",                chores:["creative-project","help-cook"] },
    4: { name:"Sports & Adventure", emoji:"⚽",       color:"#fff8e1", morning:"Sports drills, workout goals, bike ride",          afternoon:"Park, playground, or swimming",     chores:["morning-workout","help-sibling"] },
    5: { name:"Chill & Community",  emoji:"🎬",       color:"#f3e5f5", morning:"🎥 Movie Day — pick the movie, make popcorn",     afternoon:"Video games, free play",            chores:["play-together-1hr","no-fighting-day"] },
  },

  // Default daily schedule blocks.
  dailyBlocks: [
    { id:"morning-kickoff",   time:"9:30",  emoji:"☀️", label:"Morning Kickoff",        desc:"Gather up, talk about the day's plan",          hour:9,  min:30 },
    { id:"morning-activity",  time:"10:00", emoji:"🎯", label:"Morning Activity Block",  desc:null,                                             hour:10, min:0  },
    { id:"lunch-prep",        time:"11:30", emoji:"🍳", label:"Lunch Prep & Cooking",   desc:"Kids help cook",                                 hour:11, min:30 },
    { id:"lunch",             time:"12:00", emoji:"🍽️", label:"Lunch",                  desc:"Eat together",                                   hour:12, min:0  },
    { id:"quiet-time",        time:"12:30", emoji:"😴", label:"Quiet Time",             desc:"Reading, drawing, or quiet play",                hour:12, min:30 },
    { id:"afternoon-reset",   time:"2:00",  emoji:"🔄", label:"Afternoon Reset",        desc:"Stretch, snack, regroup",                        hour:14, min:0  },
    { id:"afternoon-activity",time:"2:15",  emoji:"🎯", label:"Afternoon Activity",     desc:null,                                             hour:14, min:15 },
    { id:"outdoor-time",      time:"3:45",  emoji:"🏃", label:"Outdoor / Active Time",  desc:"Bikes, sports, playground",                     hour:15, min:45 },
    { id:"clean-up",          time:"4:30",  emoji:"🧹", label:"Clean-Up & Wind-Down",   desc:"Tidy up together",                               hour:16, min:30 },
    { id:"day-wrap",          time:"4:50",  emoji:"⭐", label:"Day Wrap",               desc:"What was your favorite part?",                   hour:16, min:50 },
  ],

  // Custom blocks for specific dates (YYYY-MM-DD keys override the daily schedule).
  customDates: {
    // "2026-06-15": [
    //   { id:"field-trip", time:"10:00", emoji:"🚌", label:"Field Trip", desc:"Museum visit", hour:10, min:0 },
    //   ...
    // ],
  },

  // Optional date range that overrides dailyBlocks (like a "phase" of the program).
  // { start:[YYYY,M,D], end:[YYYY,M,D], blocks:[...] }
  // transitionRange: {
  //   start: [2026, 5, 21],
  //   end:   [2026, 5, 31],
  //   blocks: [ ... ]
  // },

  // Extra streaks beyond the 3 core ones (helping, kindness, workout).
  // These are merged into the app's streak definitions at startup.
  // vacationHold: true adds a "Vacation Keep-Alive" button kids can request.
  // extraStreaks: {
  //   "pet-care": {
  //     label: "🐾 Pet Care Streak",
  //     goal: 7,
  //     prompt: "Took care of the pet today",
  //     vacationHold: true,
  //   },
  // },
};
