import { HashRouter, Routes, Route } from "react-router-dom";
import Navbar from "./components/Navbar.jsx";
import DailyLine from "./components/DailyLine.jsx";
import UpdateBanner from "./components/UpdateBanner.jsx";
import LoginGate from "./components/LoginGate.jsx";
import ApplicationsList from "./pages/ApplicationsList.jsx";
import ApplicationDetail from "./pages/ApplicationDetail.jsx";
import NewApplication from "./pages/NewApplication.jsx";
import NewPackage from "./pages/NewPackage.jsx";
import PipelineBoard from "./pages/PipelineBoard.jsx";
import StatsPage from "./pages/StatsPage.jsx";
import RecruitersBoard from "./pages/RecruitersBoard.jsx";

export default function App() {
  return (
    <LoginGate>
      <HashRouter>
        <div className="app-shell">
          <Navbar />
          <main className="app-scroll-panel">
            <div className="container py-4">
              <UpdateBanner />
              <DailyLine />
              <Routes>
                <Route path="/" element={<ApplicationsList />} />
                <Route path="/applications/new" element={<NewApplication />} />
                <Route path="/packages/new" element={<NewPackage />} />
                <Route path="/applications/:id" element={<ApplicationDetail />} />
                <Route path="/pipeline" element={<PipelineBoard />} />
                <Route path="/stats" element={<StatsPage />} />
                <Route path="/recruiters" element={<RecruitersBoard />} />
              </Routes>
            </div>
          </main>
        </div>
      </HashRouter>
    </LoginGate>
  );
}
