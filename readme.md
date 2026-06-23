# NVSL Data Master

A tools suite for NVSL swim meet roster management, time predictions, meet sheet analysis, and automated lineup optimization.

---

## 1. Setup & Installation

### Prerequisites
- **Node.js** (v18.0.0 or higher recommended)
- **npm** (comes packaged with Node.js)

### Installation Steps
1. Clone this repository:
   ```bash
   git clone https://github.com/croznoah/nvsl-data-master.git

   cd nvsl-data-master
   ```
2. In the project root directory, install dependencies:
   ```bash
   npm install
   ```

### Running the Application

#### Development Mode
To start the local development server:
```bash
npm run dev
```
Once started, open **http://localhost:5173** in your web browser.

---

## 2. Annual Setup (Run First!)

You **must** run the **Annual Setup** utility before using the Meet Seeder tool. If this is not done, or if the saved schedules are out of date, the Seeder will automatically redirect you to the setup page.

### How to Run Setup:
1. Open the home page (**http://localhost:5173**) and click **"Open Setup"**.
2. Click the **"Start Scraping"** button.
3. The scraper will fetch the current NVSL division structure, Saturday A-Meet dates, team names, IDs, and abbreviations from the official MyNVSL site.
4. Keep the page open until the terminal logs show completion and the files are successfully saved.

---

## 3. Meet Seeder Functionality

The **Seeder** allows coaches to plan and optimize upcoming swim meet lineups.

### Core Features:
- **SwimTopia Integration**: Log in directly with your SwimTopia credentials to pull active swimmer lists, meet-specific availability/absences, and historical swim times.
- **Roster Customization**: Manually toggle swimmer availability and adjust seed times in the table.
- **Swim Time Predictions**: Automatically predicts missing event times (e.g., estimating 50m times based on a 25m best) using the backend's ONNX prediction models.
- **Automated Lineup Optimization**: Uses Integer Linear Programming (ILP) via a Web Worker to deterministically generate the highest-scoring lineup possible. The optimizer ensures:
  - Swimmers swim at most 2 individual events.
  - A maximum of 3 lanes are filled per event.
  - Seeding order constraints are respected (faster swimmers occupy faster lanes).
  - Valid age group swim-ups.
- **Score Simulations**: Estimates scores against NVSL opponents based on past history.
- **PDF Report Export**: Exports formatted NVSL seeding sheets directly to print-ready PDF files.

---

## 4. Sheet Analyzer

Used for uploading and processing Meet Maestro A-Meet heat sheets:
- Parses heat sheet PDFs to extract swimmer entries.
- Dynamically scores the meet page-by-page.
- Displays visual margins and entry logs.
