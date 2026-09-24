import { useEffect, useState } from "react";
import { checkSession, login } from "../api.js";

export default function LoginGate({ children }) {
  const [status, setStatus] = useState("checking"); // checking | needed | ok
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    checkSession()
      .then((s) => setStatus(s.passwordRequired && !s.authed ? "needed" : "ok"))
      .catch(() => setStatus("ok")); // fail open locally rather than lock the user out
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(password);
      setStatus("ok");
    } catch {
      setError("Wrong password.");
    } finally {
      setSubmitting(false);
    }
  }

  if (status === "checking") return null;

  if (status === "needed") {
    return (
      <div className="d-flex align-items-center justify-content-center" style={{ minHeight: "100vh" }}>
        <form onSubmit={handleSubmit} className="card p-4" style={{ width: 320 }}>
          <h5 className="mb-3">Ledger Dashboard</h5>
          {error && <div className="alert alert-danger py-2 px-3">{error}</div>}
          <input
            type="password"
            className="form-control mb-3"
            placeholder="Password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
          />
          <button type="submit" className="btn btn-primary rounded-pill" disabled={submitting}>
            {submitting ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    );
  }

  return children;
}
