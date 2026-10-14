# Usability test: 10 minutes per person

Goal: find out where real users get stuck before the pilot, not to demo the app. Test with people who
match each view: one control-room operator, one field crew member (on their own phone), one citizen
(not on the project team), and, if possible, one manager.

## Set-up (5 minutes, before each session)

- Open the app at 19:30 on the snapshot day, so dusk checks and the night audit are live:
  `index.html?now=2026-10-13T19:30` (or the hosted address with the same `?now=`).
- Reload the page between sessions, so every person starts from the same data.
- Citizens and crew: use a phone. Operators and managers: a laptop.
- Say: "We are testing the app, not you. Think aloud. I can't help during a task."
- Do not name buttons in the task wording. Read each task as written.

## Tasks

Time each task. Stop at 3 minutes and note where they were.

**Citizen (Citizen view)**
1. "A streetlight on Janpath, near the bus stop, is off. Tell the council." (They need to find it on the map and send a report.)
2. "A few days ago you reported a flickering light on the Outer Circle. Find out what is happening to it."
3. "It has been days. You want other people to see this complaint." (Look for whether they find **Share publicly** and understand they post it themselves.)

**Operator (Operator view)**
1. "Which complaint should a crew go to first, and why?"
2. "TKT-2026-0179 is new. What should happen to it next?" (Cheapest check first: do they understand why there's no Dispatch button?)
3. "Send a crew to the most urgent lamp fault."

**Field crew (Field crew view, crew R2)**
1. "Show your jobs for tonight in the order you'd do them."
2. "You've reached the check visit and the light is working fine. Record that."
3. "You arrive and the fault is on the next pole along. Record that."

**Manager (Management view)**
1. "Which contractor is doing worst on response times?"
2. "How many complaints are waiting for a check right now?"
3. "Stop citizens from sharing complaints on X."

## What to watch for

- Where they look first, and where they tap that isn't a control.
- Any word they read aloud and then hesitate over (note the exact word).
- Whether they expect something to happen that doesn't (e.g. a confirmation).
- Citizens: do they think the report was really sent? Do they worry about their photo or phone number?
- Crew: can they do it one-handed, outdoors, with the screen brightness up?

## Debrief (2 minutes)

1. "What was the hardest part?"
2. "Was anything missing that you'd need to do this for real?"
3. "Was any word or label confusing?"
4. Citizens, in Hindi if they prefer: "Did the Hindi read naturally? Which words would you change?"

## Results

| Person | View | Task | Done? | Time | Where they got stuck | Words that confused them |
|---|---|---|---|---|---|---|
| | | | | | | |

Afterwards, list each problem once, with how many people hit it. Fix the ones two or more people hit
before the pilot.
