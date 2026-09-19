import { HashRouter, Routes, Route } from "react-router-dom";
import Navbar from "./components/Navbar.jsx";
import DailyLine from "./components/DailyLine.jsx";
import ApplicationsList from "./pages/ApplicationsList.jsx";
import ApplicationDetail from "./pages/ApplicationDetail.jsx";
import PipelineBoard from "./pages/PipelineBoard.jsx";
import StatsPage from "./pages/StatsPage.jsx";
import RecruitersBoard from "./pages/RecruitersBoard.jsx";

export default function App() {
  return (
    <HashRouter>
      <Navbar />
      <div className="container py-4">
        <DailyLine />
        <Routes>
          <Route path="/" element={<ApplicationsList />} />
          <Route path="/applications/:id" element={<ApplicationDetail />} />
          <Route path="/pipeline" element={<PipelineBoard />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/recruiters" element={<RecruitersBoard />} />
        </Routes>
      </div>
    </HashRouter>
  );
}
