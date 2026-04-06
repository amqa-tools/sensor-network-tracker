# How the Sensor Network Tracker Works
### A plain-language guide for anyone — no technical background needed

---

## What Is This App?

The Sensor Network Tracker is a website that helps ADEC manage air quality sensors across Alaska. It tracks which sensors are where, who the contacts are at each community, and whether the sensors are working properly.

You access it by visiting this link in any web browser:
**https://amqa-tools.github.io/sensor-network-tracker/**

---

## The Three Pieces

The app is made up of three separate services that work together. Think of it like a restaurant:

### 1. The App Itself — "The Menu & Kitchen"

The app is a collection of files (like a set of documents) that tell your web browser what to show on screen and how to behave when you click buttons.

When you visit the app's web address, your browser downloads these files and runs them — just like how a PDF opens in your browser. There's no special software to install.

**Where do these files live?** On a free service called **GitHub Pages**, which works like a simple website host. The files sit there and anyone with the link can access them.

### 2. The Database (Supabase) — "The Filing Cabinet"

All the actual information — every sensor, every contact, every note, every alert — is stored in an online database called **Supabase**.

Think of Supabase as a giant secure filing cabinet in the cloud. When you add a new contact or write a note, the app puts that information into the filing cabinet. When you open the app next time, it pulls everything back out of the filing cabinet to show you.

**What's stored there:**
- All sensor records (names, locations, statuses, purchase info)
- All contacts (names, phone numbers, emails, which community they're at)
- All communities
- All notes, communication logs, and history
- All sensor health alerts
- Uploaded files
- User login accounts

### 3. GitHub — "The Safe Deposit Box"

GitHub is where the app's files are safely stored with a complete history of every change ever made. It also doubles as the website host (GitHub Pages).

Think of it like a shared drive that keeps every version of every document — so if something breaks, we can always go back to a working version. It also records who made each change and when.

**Important:** The GitHub account is owned by the **amqa-tools organization**, not any individual person's account. This means if someone leaves, the organization still owns everything.

---

## How They Work Together

Here's what happens when you use the app:

```
  You open the website in your browser
              |
              v
  Your browser loads the app files from GitHub Pages
              |
              v
  The app connects to Supabase and pulls in all your data
              |
              v
  You see your sensors, contacts, communities, etc.
              |
              v
  You make a change (add a contact, write a note, etc.)
              |
              v
  The app sends that change to Supabase, which saves it
              |
              v
  Next time anyone opens the app, they see the updated data
```

**The key thing to understand:** GitHub stores the app. Supabase stores the data. Your browser brings them together.

---

## The QuantAQ Sensor Health Checks

The app can also check whether your air quality sensors are working properly by talking to QuantAQ (the sensor manufacturer's system).

When you click "Run QuantAQ Check," the app:
1. Asks QuantAQ's system: "How are all our sensors doing?"
2. QuantAQ sends back status info for every sensor
3. The app looks for problems (sensor offline, sensor readings look wrong, etc.)
4. If there's a problem, the app creates an alert so you can investigate

**Smart filtering:** Not every flag means something is wrong. For example, after a power outage, gas sensors need a few hours to warm up and will look "broken" during that time even though they're fine. The app now waits a grace period (6 hours for gas sensors, 2 hours for lost connections) before creating an alert. If the issue goes away on its own during that window, no alert is ever created. This prevents a flood of false alarms.

---

## What Happens If Someone Leaves ADEC?

This is one of the most important questions. Here's the answer:

**The app keeps running.** Nobody needs to do anything for it to continue working day-to-day. It's not running on anyone's personal computer — it's hosted on the internet.

**Specifically:**
- The website stays live at the same URL — no action needed
- All data stays in Supabase — no action needed
- The code stays on GitHub, owned by the organization — no action needed
- QuantAQ checks continue working as long as the QuantAQ subscription is active

**What someone WOULD need to do eventually:**
- If you want new features or need to fix something, you'd need someone who can edit the code (a web developer, or even someone using an AI coding tool)
- Keep the Supabase account active (it's free right now, but if you need backups, it's $25/month)
- Keep the QuantAQ subscription active for sensor health checks

---

## Is the Data Secure?

**Yes.** Here's how:

- **Login required:** You need an email and password to access the app's data
- **Encrypted:** All data traveling between your browser and the database is encrypted (the same security your bank uses)
- **Access controls:** The database has rules about who can read and write data
- **No data on your computer:** Nothing is stored on your laptop. If your computer is lost or broken, no data is lost — it's all in the cloud

---

## What Does It Cost?

| What | Cost | Notes |
|------|------|-------|
| The website (GitHub Pages) | **Free** | No limits, no expiration |
| Code storage (GitHub) | **Free** | Includes full version history |
| Database (Supabase free plan) | **Free** | Works fine for current usage |
| Database backups (Supabase paid plan) | **$25/month** | Optional — adds automatic daily backups |
| QuantAQ sensor checks | **Already included** | Part of your existing QuantAQ subscription |
| **Total** | **$0 to $25/month** | |

---

## Backing Up Your Data

**The code** is already backed up — GitHub keeps every version of every file ever saved.

**The data** (sensors, contacts, notes) has a few backup options:
- **Export from the app:** The contacts and sensors pages have an "Export" button that downloads a spreadsheet
- **Supabase dashboard:** You can export the entire database from the Supabase website
- **Automatic daily backups:** Available on the $25/month Supabase plan — this is the "set it and forget it" option

**Recommendation:** If data loss would be a serious problem, the $25/month plan for automatic daily backups is worth it. Otherwise, periodic manual exports give you a safety net at no cost.

---

## Who Owns What

| Resource | Who Owns It | Where |
|----------|------------|-------|
| The live app | amqa-tools (GitHub org) | https://amqa-tools.github.io/sensor-network-tracker/ |
| The code | amqa-tools (GitHub org) | https://github.com/amqa-tools/sensor-network-tracker |
| The database | Whichever ADEC email is on the Supabase account | https://supabase.com/dashboard |
| QuantAQ access | ADEC's QuantAQ account | https://www.quant-aq.com/ |

**Make sure** the Supabase and GitHub accounts are registered under an ADEC organizational email (not a personal email) so access transfers naturally when staff change.

---

## Quick Glossary

| Term | What It Means |
|------|--------------|
| **GitHub** | A website that stores code files and keeps version history (like Google Drive for code) |
| **GitHub Pages** | A free feature of GitHub that turns your files into a website anyone can visit |
| **Supabase** | An online database service (think: secure cloud spreadsheet that the app reads and writes to) |
| **Repository (repo)** | A project folder on GitHub that contains all the app's files |
| **API** | A way for two systems to talk to each other over the internet (how the app talks to Supabase and QuantAQ) |
| **Edge Function** | A small program that runs on Supabase's servers, used here as a secure go-between for QuantAQ checks |
