"use client";

import { useState, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

interface Profile {
  _id: string;
  name: string;
  platform: string;
}

interface GiftCardEntry {
  cardNumber: string;
  pin: string;
}

interface HistoryEntry {
  _id: string;
  cardNumber: string;
  pin: string;
  status: "success" | "failed" | "pending";
  errorMessage?: string;
  addedAt: string;
}

export default function GiftCardsPage() {
  const { status } = useSession();
  const router = useRouter();

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [chromeProfileId, setChromeProfileId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  // Manual entry
  const [cardNumber, setCardNumber] = useState("");
  const [pin, setPin] = useState("");
  const [giftCards, setGiftCards] = useState<GiftCardEntry[]>([]);
  const [fieldErrors, setFieldErrors] = useState<{ cardNumber?: string; pin?: string }>({});

  // CSV
  const [csvText, setCsvText] = useState("");
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Tab
  const [activeTab, setActiveTab] = useState<"add" | "history">("add");

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    if (status === "authenticated") {
      fetchProfiles();
      fetchHistory();
    }
  }, [status, router]);

  async function fetchProfiles() {
    const res = await fetch("/api/profiles");
    if (res.ok) {
      const data = await res.json();
      setProfiles(data);
      if (data.length > 0) setChromeProfileId(data[0]._id);
    }
  }

  async function fetchHistory() {
    setHistoryLoading(true);
    try {
      const res = await fetch("/api/giftcards/history");
      if (res.ok) setHistory(await res.json());
    } finally {
      setHistoryLoading(false);
    }
  }

  function validateCard(cn: string, p: string): { cardNumber?: string; pin?: string } {
    const errors: { cardNumber?: string; pin?: string } = {};
    const cleanNum = cn.replace(/[\s-]/g, "");
    if (!cleanNum) {
      errors.cardNumber = "Card number is required";
    } else if (cleanNum.length < 10) {
      errors.cardNumber = "Card number is too short";
    }
    if (!p) {
      errors.pin = "PIN is required";
    } else if (!/^\d+$/.test(p)) {
      errors.pin = "PIN must be numeric";
    } else if (p.length < 4) {
      errors.pin = "PIN must be at least 4 digits";
    }
    return errors;
  }

  function addCard() {
    const errors = validateCard(cardNumber, pin);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const cleanNum = cardNumber.replace(/[\s-]/g, "");

    // Check if already in queue
    if (giftCards.some((gc) => gc.cardNumber === cleanNum)) {
      setError("This card is already in the queue");
      return;
    }

    setGiftCards([...giftCards, { cardNumber: cleanNum, pin: pin.trim() }]);
    setCardNumber("");
    setPin("");
    setError("");
    setFieldErrors({});
  }

  function removeCard(index: number) {
    setGiftCards(giftCards.filter((_, i) => i !== index));
  }

  function parseCSV(text: string): { entries: GiftCardEntry[]; errors: string[] } {
    const entries: GiftCardEntry[] = [];
    const errors: string[] = [];
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split(",").map((p) => p.trim());
      if (parts.length < 2 || !parts[0] || !parts[1]) {
        errors.push(`Row ${i + 1}: Invalid format (need cardNumber,pin)`);
        continue;
      }
      const cn = parts[0].replace(/[\s-]/g, "");
      const p = parts[1];
      if (cn.length < 10) {
        errors.push(`Row ${i + 1}: Card number too short`);
        continue;
      }
      if (!/^\d+$/.test(p)) {
        errors.push(`Row ${i + 1}: PIN must be numeric`);
        continue;
      }
      entries.push({ cardNumber: cn, pin: p });
    }
    return { entries, errors };
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setCsvText(text);
      const { entries, errors } = parseCSV(text);
      setCsvErrors(errors);
      if (entries.length > 0) {
        // Dedupe against existing queue
        const existing = new Set(giftCards.map((gc) => gc.cardNumber));
        const newEntries = entries.filter((e) => !existing.has(e.cardNumber));
        setGiftCards((prev) => [...prev, ...newEntries]);
        setSuccess(`Loaded ${newEntries.length} new gift cards from file${entries.length - newEntries.length > 0 ? ` (${entries.length - newEntries.length} duplicates skipped)` : ""}`);
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function loadFromTextarea() {
    const { entries, errors } = parseCSV(csvText);
    setCsvErrors(errors);
    if (entries.length > 0) {
      const existing = new Set(giftCards.map((gc) => gc.cardNumber));
      const newEntries = entries.filter((e) => !existing.has(e.cardNumber));
      setGiftCards((prev) => [...prev, ...newEntries]);
      setCsvText("");
      setSuccess(`Added ${newEntries.length} gift cards`);
      setError("");
    } else if (errors.length === 0) {
      setError("No valid entries found. Format: cardNumber,pin (one per line)");
    }
  }

  async function startAdding() {
    if (giftCards.length === 0) {
      setError("Add at least one gift card first");
      return;
    }
    if (!chromeProfileId) {
      setError("Select a Chrome profile");
      return;
    }

    setLoading(true);
    setError("");
    setSuccess("");
    setLogs([]);

    try {
      const res = await fetch("/api/giftcards/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chromeProfileId, giftCards }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to add gift cards");
        setLoading(false);
        return;
      }

      setLogs(data.logs || []);
      const parts = [];
      if (data.completed > 0) parts.push(`${data.completed} added`);
      if (data.failed > 0) parts.push(`${data.failed} failed`);
      if (data.skipped > 0) parts.push(`${data.skipped} skipped (already added)`);
      setSuccess(`Done! ${parts.join(", ")} out of ${data.total} total.`);
      setGiftCards([]);
      fetchHistory();
    } catch {
      setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const statusBadge = (s: string) => {
    switch (s) {
      case "success":
        return "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
      case "failed":
        return "bg-red-500/10 text-red-400 border border-red-500/20";
      default:
        return "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20";
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1">Flipkart Gift Cards</h1>
        <p className="text-sm text-gray-400">
          Add gift cards to your Flipkart account automatically
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-gray-900 rounded-xl p-1 border border-gray-800 w-fit">
        <button
          onClick={() => setActiveTab("add")}
          className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${
            activeTab === "add"
              ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20"
              : "text-gray-400 hover:text-white hover:bg-gray-800"
          }`}
        >
          Add Gift Cards
        </button>
        <button
          onClick={() => setActiveTab("history")}
          className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${
            activeTab === "history"
              ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20"
              : "text-gray-400 hover:text-white hover:bg-gray-800"
          }`}
        >
          History
          {history.length > 0 && (
            <span className="ml-2 text-xs bg-gray-700 px-2 py-0.5 rounded-full">
              {history.length}
            </span>
          )}
        </button>
      </div>

      {/* Alerts */}
      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm flex items-start gap-2">
          <span className="shrink-0 mt-0.5">&#x2715;</span>
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400 text-sm flex items-start gap-2">
          <span className="shrink-0 mt-0.5">&#x2713;</span>
          <span>{success}</span>
        </div>
      )}

      {activeTab === "add" ? (
        <>
          {/* Chrome Profile */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Chrome Profile
            </label>
            <select
              value={chromeProfileId}
              onChange={(e) => setChromeProfileId(e.target.value)}
              className="w-full px-4 py-2.5 bg-gray-900 border border-gray-800 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
            >
              {profiles.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name} ({p.platform})
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Must be logged into Flipkart
            </p>
          </div>

          {/* Manual Entry */}
          <div className="mb-6 p-5 bg-gray-900 rounded-xl border border-gray-800">
            <h3 className="text-sm font-semibold text-gray-200 mb-4">
              Add Card Manually
            </h3>
            <div className="flex gap-3 items-start">
              <div className="flex-1">
                <input
                  type="text"
                  value={cardNumber}
                  onChange={(e) => {
                    setCardNumber(e.target.value);
                    setFieldErrors((p) => ({ ...p, cardNumber: undefined }));
                  }}
                  placeholder="Gift Card Number"
                  className={`w-full px-4 py-2.5 bg-gray-800 border rounded-xl text-white font-mono focus:outline-none focus:ring-2 transition-all ${
                    fieldErrors.cardNumber
                      ? "border-red-500/50 focus:ring-red-500/40"
                      : "border-gray-700 focus:ring-blue-500/40 focus:border-blue-500/40"
                  }`}
                />
                {fieldErrors.cardNumber && (
                  <p className="text-xs text-red-400 mt-1">{fieldErrors.cardNumber}</p>
                )}
              </div>
              <div className="w-40">
                <input
                  type="text"
                  value={pin}
                  onChange={(e) => {
                    setPin(e.target.value.replace(/\D/g, ""));
                    setFieldErrors((p) => ({ ...p, pin: undefined }));
                  }}
                  placeholder="PIN"
                  maxLength={8}
                  className={`w-full px-4 py-2.5 bg-gray-800 border rounded-xl text-white font-mono focus:outline-none focus:ring-2 transition-all ${
                    fieldErrors.pin
                      ? "border-red-500/50 focus:ring-red-500/40"
                      : "border-gray-700 focus:ring-blue-500/40 focus:border-blue-500/40"
                  }`}
                />
                {fieldErrors.pin && (
                  <p className="text-xs text-red-400 mt-1">{fieldErrors.pin}</p>
                )}
              </div>
              <button
                type="button"
                onClick={addCard}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl transition-all text-sm font-medium shadow-lg shadow-blue-600/10"
              >
                Add
              </button>
            </div>
          </div>

          {/* CSV Upload */}
          <div className="mb-6 p-5 bg-gray-900 rounded-xl border border-gray-800">
            <h3 className="text-sm font-semibold text-gray-200 mb-1">
              Bulk Import (CSV)
            </h3>
            <p className="text-xs text-gray-500 mb-4">
              Format: <code className="text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">cardNumber,pin</code> — one per line
            </p>
            <div className="flex gap-3 mb-3 items-center">
              <label className="flex-1 cursor-pointer">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.txt"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <div className="px-4 py-2.5 bg-gray-800 border border-gray-700 border-dashed rounded-xl text-sm text-gray-400 text-center hover:border-blue-500/40 hover:text-blue-400 transition-all">
                  Click to upload .csv or .txt file
                </div>
              </label>
            </div>
            <textarea
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              placeholder={"XXXX-XXXX-XXXX-XXXX,123456\nYYYY-YYYY-YYYY-YYYY,654321"}
              rows={4}
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all mb-3"
            />
            {csvErrors.length > 0 && (
              <div className="mb-3 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400 space-y-0.5">
                {csvErrors.map((err, i) => (
                  <div key={i}>{err}</div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={loadFromTextarea}
              disabled={!csvText.trim()}
              className="px-5 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white rounded-xl transition-all text-sm font-medium"
            >
              Load from Text
            </button>
          </div>

          {/* Cards Queue */}
          {giftCards.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-200">
                  Queue ({giftCards.length} card{giftCards.length !== 1 ? "s" : ""})
                </h3>
                <button
                  onClick={() => setGiftCards([])}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  Clear All
                </button>
              </div>
              <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="text-left px-4 py-2.5 text-gray-500 font-medium text-xs uppercase tracking-wider">#</th>
                      <th className="text-left px-4 py-2.5 text-gray-500 font-medium text-xs uppercase tracking-wider">Card Number</th>
                      <th className="text-left px-4 py-2.5 text-gray-500 font-medium text-xs uppercase tracking-wider">PIN</th>
                      <th className="px-4 py-2.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {giftCards.map((gc, i) => (
                      <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                        <td className="px-4 py-2.5 text-gray-500">{i + 1}</td>
                        <td className="px-4 py-2.5 text-white font-mono">{gc.cardNumber}</td>
                        <td className="px-4 py-2.5 text-white font-mono">{gc.pin}</td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={() => removeCard(i)}
                            className="text-red-400 hover:text-red-300 text-xs transition-colors"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Start Button */}
          <button
            onClick={startAdding}
            disabled={loading || giftCards.length === 0 || !chromeProfileId}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600 text-white font-semibold rounded-xl transition-all shadow-lg shadow-emerald-600/10 mb-6"
          >
            {loading
              ? `Processing ${giftCards.length} Gift Cards...`
              : `Add ${giftCards.length || 0} Gift Card${giftCards.length !== 1 ? "s" : ""} to Account`}
          </button>

          {/* Logs */}
          {logs.length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-gray-200 mb-3">
                Output Logs
              </h3>
              <div className="bg-gray-950 border border-gray-800 rounded-xl p-4 max-h-80 overflow-y-auto">
                {logs.map((log, i) => (
                  <div
                    key={i}
                    className={`text-xs font-mono mb-1 leading-relaxed ${
                      log.includes("[ERROR]")
                        ? "text-red-400"
                        : log.includes("[WARN]")
                        ? "text-yellow-400"
                        : log.includes("success")
                        ? "text-emerald-400"
                        : "text-gray-500"
                    }`}
                  >
                    {log}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        /* History Tab */
        <div>
          {historyLoading ? (
            <div className="text-center py-12 text-gray-500">Loading history...</div>
          ) : history.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
              <p className="text-gray-500">No gift cards have been added yet.</p>
            </div>
          ) : (
            <>
              {/* Stats */}
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="p-4 bg-gray-900 rounded-xl border border-gray-800 text-center">
                  <p className="text-2xl font-bold text-white">{history.length}</p>
                  <p className="text-xs text-gray-500 mt-1">Total</p>
                </div>
                <div className="p-4 bg-gray-900 rounded-xl border border-gray-800 text-center">
                  <p className="text-2xl font-bold text-emerald-400">
                    {history.filter((h) => h.status === "success").length}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">Added</p>
                </div>
                <div className="p-4 bg-gray-900 rounded-xl border border-gray-800 text-center">
                  <p className="text-2xl font-bold text-red-400">
                    {history.filter((h) => h.status === "failed").length}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">Failed</p>
                </div>
              </div>

              <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider">Card Number</th>
                      <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider">Status</th>
                      <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider">Error</th>
                      <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h._id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                        <td className="px-4 py-3 text-white font-mono">{h.cardNumber}</td>
                        <td className="px-4 py-3">
                          <span className={`px-2.5 py-1 rounded-lg text-xs font-medium ${statusBadge(h.status)}`}>
                            {h.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 max-w-48 truncate">
                          {h.errorMessage || "—"}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500">
                          {new Date(h.addedAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
