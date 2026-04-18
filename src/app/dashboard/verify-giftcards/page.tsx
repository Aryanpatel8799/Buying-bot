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
  balance?: string;
  status?: "success" | "error" | "";
}

const MAX_CARDS_PER_SUBMIT = 5000;

export default function VerifyGiftCardsPage() {
  const { status } = useSession();
  const router = useRouter();

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [chromeProfileId, setChromeProfileId] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [giftCards, setGiftCards] = useState<GiftCardEntry[]>([]);

  // Manual entry
  const [cardNumber, setCardNumber] = useState("");
  const [pin, setPin] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ cardNumber?: string; pin?: string }>({});

  // CSV
  const [csvText, setCsvText] = useState("");
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // SSE stream handle (for async job progress)
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    if (status === "authenticated") fetchProfiles();
  }, [status, router]);

  // Close the stream when the component unmounts
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  async function fetchProfiles() {
    const res = await fetch("/api/profiles");
    if (res.ok) {
      const data = await res.json();
      setProfiles(data);
      if (data.length > 0) setChromeProfileId(data[0]._id);
    }
  }

  function addCard() {
    const errors: { cardNumber?: string; pin?: string } = {};
    const cleanNum = cardNumber.replace(/[\s-]/g, "");
    if (!cleanNum) errors.cardNumber = "Card number is required";
    else if (cleanNum.length < 4) errors.cardNumber = "Card number is too short";
    if (!pin) errors.pin = "PIN is required";
    else if (!/^\d+$/.test(pin)) errors.pin = "PIN must be numeric";

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    if (giftCards.some((gc) => gc.cardNumber === cleanNum)) {
      setError("This card is already in the queue");
      return;
    }
    if (giftCards.length >= MAX_CARDS_PER_SUBMIT) {
      setError(`Queue is full (${MAX_CARDS_PER_SUBMIT.toLocaleString()} max per submission)`);
      return;
    }

    setGiftCards([...giftCards, { cardNumber: cleanNum, pin: pin.trim(), balance: "", status: "" }]);
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
      const line = lines[i];
      if (i === 0 && (line.toLowerCase().includes("cardnumber") || line.toLowerCase().includes("card_number") || line.toLowerCase().includes("code"))) {
        continue;
      }

      const parts = line.split(",").map((p) => p.trim());
      if (!parts[0]) {
        errors.push(`Row ${i + 1}: Empty card number`);
        continue;
      }

      const cn = parts[0].replace(/[\s-]/g, "");
      const p = parts[1] || "";

      if (cn.length < 4) {
        errors.push(`Row ${i + 1}: Card number too short`);
        continue;
      }
      if (!p) {
        errors.push(`Row ${i + 1}: PIN is required`);
        continue;
      }
      if (!/^\d*$/.test(p)) {
        errors.push(`Row ${i + 1}: PIN must be numeric`);
        continue;
      }

      entries.push({ cardNumber: cn, pin: p, balance: "", status: "" });
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
        const existing = new Set(giftCards.map((gc) => gc.cardNumber));
        const newEntries = entries.filter((e) => !existing.has(e.cardNumber));
        const roomLeft = Math.max(0, MAX_CARDS_PER_SUBMIT - giftCards.length);
        const accepted = newEntries.slice(0, roomLeft);
        const capped = newEntries.length - accepted.length;
        setGiftCards((prev) => [...prev, ...accepted]);
        const skippedCount = entries.length - newEntries.length;
        const parts = [`Loaded ${accepted.length} gift cards from file`];
        if (skippedCount > 0) parts.push(`${skippedCount} duplicates skipped`);
        if (capped > 0) parts.push(`${capped} over the ${MAX_CARDS_PER_SUBMIT.toLocaleString()} per-submission cap`);
        setSuccess(parts.join(" · "));
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
      const roomLeft = Math.max(0, MAX_CARDS_PER_SUBMIT - giftCards.length);
      const accepted = newEntries.slice(0, roomLeft);
      const capped = newEntries.length - accepted.length;
      setGiftCards((prev) => [...prev, ...accepted]);
      setCsvText("");
      const parts = [`Added ${accepted.length} gift cards`];
      if (capped > 0) parts.push(`${capped} over the ${MAX_CARDS_PER_SUBMIT.toLocaleString()} per-submission cap`);
      setSuccess(parts.join(" · "));
      setError("");
    } else if (errors.length === 0) {
      setError("No valid entries found. Format: cardNumber,pin (one per line)");
    }
  }

  async function startChecking() {
    if (giftCards.length === 0) {
      setError("Add at least one gift card first");
      return;
    }
    if (giftCards.length > MAX_CARDS_PER_SUBMIT) {
      setError(`Maximum ${MAX_CARDS_PER_SUBMIT.toLocaleString()} cards per submission — remove some from the queue`);
      return;
    }
    if (!chromeProfileId) {
      setError("Select a Chrome profile");
      return;
    }
    if (!phoneNumber || phoneNumber.replace(/[\s-]/g, "").length < 10) {
      setError("Enter a valid phone number for woohoo.in login");
      return;
    }

    setLoading(true);
    setError("");
    setSuccess("");
    setLogs([]);

    // Reset statuses
    setGiftCards((prev) => prev.map((gc) => ({ ...gc, balance: "", status: "" })));

    try {
      const res = await fetch("/api/giftcards/check-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chromeProfileId,
          phoneNumber: phoneNumber.replace(/[\s-]/g, ""),
          giftCards: giftCards.map((gc) => ({
            cardNumber: gc.cardNumber,
            pin: gc.pin,
          })),
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.jobId) {
        setError(data.error || "Failed to queue balance check");
        setLoading(false);
        return;
      }

      subscribeToJob(data.jobId);
    } catch {
      setError("Something went wrong");
      setLoading(false);
    }
  }

  function subscribeToJob(jobId: string) {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    const es = new EventSource(`/api/giftcards/jobs/${jobId}/stream`);
    eventSourceRef.current = es;

    es.addEventListener("log", (ev) => {
      try {
        const l = JSON.parse((ev as MessageEvent).data);
        setLogs((prev) => [...prev, `[${(l.level || "info").toUpperCase()}] ${l.message}`]);
      } catch { /* ignore */ }
    });

    es.addEventListener("card_status", (ev) => {
      try {
        const c = JSON.parse((ev as MessageEvent).data) as {
          cardNumber: string; balance?: string; status: "success" | "error";
        };
        setGiftCards((prev) =>
          prev.map((gc) =>
            gc.cardNumber === c.cardNumber
              ? { ...gc, balance: c.balance ?? gc.balance, status: c.status }
              : gc
          )
        );
      } catch { /* ignore */ }
    });

    es.addEventListener("done", (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as {
          status: string; total: number; completed: number; failed: number; errorMessage?: string;
        };
        const parts: string[] = [];
        if (d.completed > 0) parts.push(`${d.completed} checked`);
        if (d.failed > 0) parts.push(`${d.failed} failed`);
        if (d.status === "failed") {
          setError(d.errorMessage || "Job failed");
        } else {
          setSuccess(`Done! ${parts.join(", ") || "no cards"} out of ${d.total} total.`);
        }
      } catch { /* ignore */ }
      es.close();
      eventSourceRef.current = null;
      setLoading(false);
    });

    es.onerror = () => {
      setLogs((prev) => [...prev, "[WARN] Stream connection interrupted — reconnecting..."]);
    };
  }

  function downloadResultCSV() {
    const rows: string[] = ["cardNumber,pin,balance,status"];
    for (const gc of giftCards) {
      const balance = (gc.balance || "").replace(/,/g, "");
      rows.push(`${gc.cardNumber},${gc.pin},${balance},${gc.status || ""}`);
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `giftcard-balances-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const hasResults = giftCards.some((gc) => gc.status);

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1">Verify Gift Cards</h1>
        <p className="text-sm text-gray-400">
          Check Flipkart gift card balances via woohoo.in
        </p>
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

      {/* Chrome Profile + Phone Number */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
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
            Profile will be used to open Chrome
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Phone Number (woohoo.in)
          </label>
          <input
            type="text"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value.replace(/[^\d\s-+]/g, ""))}
            placeholder="Enter phone number"
            maxLength={15}
            className="w-full px-4 py-2.5 bg-gray-900 border border-gray-800 rounded-xl text-white font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
          />
          <p className="text-xs text-gray-500 mt-1">
            OTP will be sent to this number for login
          </p>
        </div>
      </div>

      {/* Manual Entry */}
      <div className="mb-6 p-5 bg-gray-900 rounded-xl border border-gray-800">
        <h3 className="text-sm font-semibold text-gray-200 mb-4">Add Card Manually</h3>
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
            className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition-all shadow-lg shadow-blue-600/20"
          >
            Add
          </button>
        </div>
      </div>

      {/* CSV Import */}
      <div className="mb-6 p-5 bg-gray-900 rounded-xl border border-gray-800">
        <h3 className="text-sm font-semibold text-gray-200 mb-4">Import from CSV</h3>
        <p className="text-xs text-gray-500 mb-3">
          Format: cardNumber,pin (one per line). First row can be a header.
        </p>
        <div className="flex gap-3 mb-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt"
            onChange={handleFileUpload}
            className="text-sm text-gray-400 file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:bg-gray-800 file:text-white hover:file:bg-gray-700 file:cursor-pointer file:transition-all"
          />
        </div>
        <div className="flex gap-3 items-start">
          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={"cardNumber,pin\n1234567890,1234\n0987654321,5678"}
            rows={4}
            className="flex-1 px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
          />
          <button
            type="button"
            onClick={loadFromTextarea}
            className="px-5 py-2.5 bg-gray-700 text-white rounded-xl text-sm font-medium hover:bg-gray-600 transition-all"
          >
            Load
          </button>
        </div>
        {csvErrors.length > 0 && (
          <div className="mt-3 p-3 bg-red-500/10 border border-red-500/20 rounded-xl">
            {csvErrors.map((e, i) => (
              <p key={i} className="text-xs text-red-400">{e}</p>
            ))}
          </div>
        )}
      </div>

      {/* Queue */}
      {giftCards.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-200">
              Gift Cards ({giftCards.length})
            </h3>
            <div className="flex gap-2">
              {hasResults && (
                <button
                  onClick={downloadResultCSV}
                  className="px-4 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 transition-all"
                >
                  Download CSV with Balances
                </button>
              )}
              <button
                onClick={() => {
                  setGiftCards([]);
                  setSuccess("");
                  setError("");
                }}
                className="px-4 py-1.5 bg-gray-800 text-gray-300 rounded-lg text-xs font-medium hover:bg-gray-700 transition-all"
              >
                Clear All
              </button>
            </div>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-400">
                  <th className="text-left px-4 py-2.5 font-medium">#</th>
                  <th className="text-left px-4 py-2.5 font-medium">Card Number</th>
                  <th className="text-left px-4 py-2.5 font-medium">PIN</th>
                  <th className="text-left px-4 py-2.5 font-medium">Balance</th>
                  <th className="text-left px-4 py-2.5 font-medium">Status</th>
                  <th className="text-right px-4 py-2.5 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {giftCards.map((gc, i) => (
                  <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                    <td className="px-4 py-2.5 text-gray-500">{i + 1}</td>
                    <td className="px-4 py-2.5 font-mono text-white">{gc.cardNumber}</td>
                    <td className="px-4 py-2.5 font-mono text-gray-400">{gc.pin}</td>
                    <td className="px-4 py-2.5 font-mono">
                      {gc.balance ? (
                        <span className={gc.status === "success" ? "text-emerald-400" : "text-red-400"}>
                          {gc.balance}
                        </span>
                      ) : (
                        <span className="text-gray-600">--</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {gc.status ? (
                        <span
                          className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium ${
                            gc.status === "success"
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                              : "bg-red-500/10 text-red-400 border border-red-500/20"
                          }`}
                        >
                          {gc.status === "success" ? "Checked" : "Error"}
                        </span>
                      ) : (
                        <span className="text-gray-600 text-xs">Pending</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {!loading && (
                        <button
                          onClick={() => removeCard(i)}
                          className="text-gray-500 hover:text-red-400 transition-colors text-xs"
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Action Button */}
      <div className="mb-6">
        <button
          onClick={startChecking}
          disabled={loading || giftCards.length === 0}
          className={`w-full py-3 rounded-xl text-sm font-semibold transition-all ${
            loading || giftCards.length === 0
              ? "bg-gray-800 text-gray-500 cursor-not-allowed"
              : "bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-600/20"
          }`}
        >
          {loading ? "Checking Balances... (enter OTP in browser if prompted)" : `Check Balance for ${giftCards.length} Card${giftCards.length !== 1 ? "s" : ""}`}
        </button>
        {loading && (
          <p className="text-xs text-yellow-400 mt-2 text-center">
            A Chrome window will open. Enter the OTP manually when prompted on woohoo.in.
          </p>
        )}
      </div>

      {/* Logs */}
      {logs.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-200 mb-3">Logs</h3>
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 max-h-64 overflow-y-auto">
            {logs.map((log, i) => (
              <p
                key={i}
                className={`text-xs font-mono mb-1 ${
                  log.includes("[ERROR]")
                    ? "text-red-400"
                    : log.includes("[WARN]")
                    ? "text-yellow-400"
                    : "text-gray-400"
                }`}
              >
                {log}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
