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
  status?: "added" | "not added" | "";
}

interface HistoryEntry {
  _id: string;
  cardNumber: string;
  pin: string;
  status: "success" | "failed" | "pending";
  errorMessage?: string;
  addedAt: string;
}

interface CardStatus {
  cardNumber: string;
  status: "added" | "not added";
}

const MAX_CARDS_PER_SUBMIT = 5000;

interface SavedAccount {
  _id: string;
  label: string;
  maskedEmail: string;
}

interface InstaDdrGroup {
  _id: string;
  label: string;
  platform: string;
  totalAccounts: number;
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
  const eventSourceRef = useRef<EventSource | null>(null);

  // Platform selector
  const [platform, setPlatform] = useState<"flipkart" | "amazon">("flipkart");

  // Flipkart account login (single-select; optional)
  const [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>([]);
  const [useAccountLogin, setUseAccountLogin] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState("");

  // InstaDDR auto-OTP (single-select; optional, requires account login)
  const [instaDdrGroups, setInstaDdrGroups] = useState<InstaDdrGroup[]>([]);
  const [useInstaDdr, setUseInstaDdr] = useState(false);
  const [selectedInstaDdrGroupId, setSelectedInstaDdrGroupId] = useState("");

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
      fetchSavedAccounts();
      fetchInstaDdrGroups();
    }
  }, [status, router]);

  async function fetchSavedAccounts() {
    const res = await fetch("/api/accounts");
    if (res.ok) setSavedAccounts(await res.json());
  }

  async function fetchInstaDdrGroups() {
    const res = await fetch("/api/instaddr");
    if (res.ok) setInstaDdrGroups(await res.json());
  }

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
    } else if (cleanNum.length < 4) {
      errors.cardNumber = "Card number is too short";
    }
    // PIN is required for Flipkart but optional for Amazon
    if (platform === "flipkart") {
      if (!p) {
        errors.pin = "PIN is required for Flipkart";
      } else if (!/^\d+$/.test(p)) {
        errors.pin = "PIN must be numeric";
      } else if (p.length < 4) {
        errors.pin = "PIN must be at least 4 digits";
      }
    }
    return errors;
  }

  function addCard() {
    const errors = validateCard(cardNumber, pin);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const cleanNum = cardNumber.replace(/[\s-]/g, "");

    if (giftCards.some((gc) => gc.cardNumber === cleanNum)) {
      setError("This card is already in the queue");
      return;
    }
    if (giftCards.length >= MAX_CARDS_PER_SUBMIT) {
      setError(`Queue is full (${MAX_CARDS_PER_SUBMIT.toLocaleString()} max per submission)`);
      return;
    }

    setGiftCards([...giftCards, { cardNumber: cleanNum, pin: pin.trim(), status: "" }]);
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
      // Skip header row
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
      const existingStatus = (parts[2] || "").toLowerCase().trim();

      // Skip rows already marked as "added"
      if (existingStatus === "added") {
        continue;
      }

      if (cn.length < 4) {
        errors.push(`Row ${i + 1}: Card number too short`);
        continue;
      }

      // PIN validation: required for Flipkart, optional for Amazon
      if (platform === "flipkart" && !p) {
        errors.push(`Row ${i + 1}: PIN is required for Flipkart`);
        continue;
      }
      if (p && !/^\d*$/.test(p)) {
        errors.push(`Row ${i + 1}: PIN must be numeric`);
        continue;
      }

      entries.push({
        cardNumber: cn,
        pin: p,
        status: existingStatus === "not added" ? "not added" : "",
      });
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

  async function startAdding() {
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

    if (useAccountLogin && !selectedAccountId) {
      setError("Select a Flipkart account or turn off account login");
      return;
    }
    if (useInstaDdr && !selectedInstaDdrGroupId) {
      setError("Select an InstaDDR group or turn off auto-OTP");
      return;
    }
    if (useInstaDdr && !useAccountLogin) {
      setError("InstaDDR auto-OTP requires account login — enable account login first");
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
        body: JSON.stringify({
          chromeProfileId,
          platform,
          ...(useAccountLogin && selectedAccountId ? { accountId: selectedAccountId } : {}),
          ...(useAccountLogin && useInstaDdr && selectedInstaDdrGroupId
            ? { instaDdrAccountId: selectedInstaDdrGroupId }
            : {}),
          giftCards: giftCards.map((gc) => ({
            cardNumber: gc.cardNumber,
            pin: gc.pin,
          })),
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.jobId) {
        setError(data.error || "Failed to queue gift card job");
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
    // Close any previous stream
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
      } catch { /* ignore malformed */ }
    });

    es.addEventListener("card_status", (ev) => {
      try {
        const c = JSON.parse((ev as MessageEvent).data) as { cardNumber: string; status: "added" | "not added" };
        setGiftCards((prev) =>
          prev.map((gc) =>
            gc.cardNumber === c.cardNumber ? { ...gc, status: c.status } : gc
          )
        );
      } catch { /* ignore */ }
    });

    es.addEventListener("done", (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as {
          status: string; total: number; completed: number; failed: number; skipped: number; errorMessage?: string;
        };
        const parts: string[] = [];
        if (d.completed > 0) parts.push(`${d.completed} added`);
        if (d.failed > 0) parts.push(`${d.failed} failed`);
        if (d.skipped > 0) parts.push(`${d.skipped} skipped (already added)`);
        if (d.status === "failed") {
          setError(d.errorMessage || "Job failed");
        } else {
          setSuccess(`Done! ${parts.join(", ") || "no cards"} out of ${d.total} total.`);
        }
        fetchHistory();
      } catch { /* ignore */ }
      es.close();
      eventSourceRef.current = null;
      setLoading(false);
    });

    es.onerror = () => {
      // Browser will auto-reconnect; surface a non-fatal notice. If it fails
      // permanently and the job is truly gone, the GET endpoint will tell us.
      setLogs((prev) => [...prev, "[WARN] Stream connection interrupted — reconnecting..."]);
    };
  }

  // Clean up the stream on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  function downloadCSV() {
    // Generate CSV from current queue with status column
    const hasQueue = giftCards.length > 0 && giftCards.some((gc) => gc.status);
    const source = hasQueue ? giftCards : [];

    // Also include history if no queue results
    const rows: string[] = ["cardNumber,pin,status"];

    if (hasQueue) {
      for (const gc of giftCards) {
        rows.push(`${gc.cardNumber},${gc.pin},${gc.status || ""}`);
      }
    } else {
      // Download from history
      for (const h of history) {
        const status = h.status === "success" ? "added" : h.status === "failed" ? "not added" : "";
        rows.push(`${h.cardNumber},,${status}`);
      }
    }

    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `giftcards-${platform}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadHistoryCSV() {
    const rows: string[] = ["cardNumber,status,error,date"];
    for (const h of history) {
      const status = h.status === "success" ? "added" : h.status === "failed" ? "not added" : "";
      const error = (h.errorMessage || "").replace(/,/g, ";");
      const date = new Date(h.addedAt).toLocaleString();
      rows.push(`${h.cardNumber},${status},${error},${date}`);
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `giftcard-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const statusBadge = (s: string) => {
    switch (s) {
      case "success":
      case "added":
        return "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
      case "failed":
      case "not added":
        return "bg-red-500/10 text-red-400 border border-red-500/20";
      default:
        return "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20";
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1">Gift Cards</h1>
        <p className="text-sm text-gray-400">
          Add gift cards to your Flipkart or Amazon account automatically
        </p>
      </div>

      {/* Platform Selector */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setPlatform("flipkart")}
          className={`px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
            platform === "flipkart"
              ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20"
              : "bg-gray-900 text-gray-400 border border-gray-800 hover:text-white hover:border-gray-700"
          }`}
        >
          🛒 Flipkart
        </button>
        <button
          onClick={() => setPlatform("amazon")}
          className={`px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
            platform === "amazon"
              ? "bg-orange-600 text-white shadow-lg shadow-orange-600/20"
              : "bg-gray-900 text-gray-400 border border-gray-800 hover:text-white hover:border-gray-700"
          }`}
        >
          📦 Amazon
        </button>
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
              {platform === "flipkart"
                ? useAccountLogin
                  ? "The bot will log into the chosen account before adding cards"
                  : "Must already be logged into Flipkart, or enable account login below"
                : "Must be logged into Amazon"}
            </p>
          </div>

          {/* Flipkart account login (single-select) */}
          {platform === "flipkart" && (
            <div className="mb-6 p-5 bg-gray-900 rounded-xl border border-gray-800">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-gray-200">Account Login</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Log into a specific Flipkart account before adding cards
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const next = !useAccountLogin;
                    setUseAccountLogin(next);
                    if (!next) {
                      setSelectedAccountId("");
                      setUseInstaDdr(false);
                      setSelectedInstaDdrGroupId("");
                    }
                  }}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    useAccountLogin ? "bg-blue-600" : "bg-gray-700"
                  }`}
                  aria-label="Toggle account login"
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      useAccountLogin ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>

              {useAccountLogin && (
                <>
                  {savedAccounts.length === 0 ? (
                    <div className="text-sm text-gray-400 p-3 bg-gray-800 rounded-lg border border-gray-700">
                      No saved Flipkart accounts.{" "}
                      <a href="/dashboard/accounts" className="text-blue-400 hover:text-blue-300">
                        Add one first →
                      </a>
                    </div>
                  ) : (
                    <select
                      value={selectedAccountId}
                      onChange={(e) => setSelectedAccountId(e.target.value)}
                      className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
                    >
                      <option value="">— Select an account —</option>
                      {savedAccounts.map((a) => (
                        <option key={a._id} value={a._id}>
                          {a.label} ({a.maskedEmail})
                        </option>
                      ))}
                    </select>
                  )}

                  {/* InstaDDR auto-OTP — only shown when account login is on */}
                  <div className="mt-4 pt-4 border-t border-gray-800">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h4 className="text-sm font-semibold text-gray-200">InstaDDR Auto-OTP</h4>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Automatically fetch the Flipkart OTP from InstaDDR
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const next = !useInstaDdr;
                          setUseInstaDdr(next);
                          if (!next) setSelectedInstaDdrGroupId("");
                        }}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          useInstaDdr ? "bg-blue-600" : "bg-gray-700"
                        }`}
                        aria-label="Toggle InstaDDR"
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            useInstaDdr ? "translate-x-6" : "translate-x-1"
                          }`}
                        />
                      </button>
                    </div>

                    {useInstaDdr && (
                      instaDdrGroups.length === 0 ? (
                        <div className="text-sm text-gray-400 p-3 bg-gray-800 rounded-lg border border-gray-700">
                          No InstaDDR groups.{" "}
                          <a href="/dashboard/instaddr" className="text-blue-400 hover:text-blue-300">
                            Add one first →
                          </a>
                        </div>
                      ) : (
                        <select
                          value={selectedInstaDdrGroupId}
                          onChange={(e) => setSelectedInstaDdrGroupId(e.target.value)}
                          className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
                        >
                          <option value="">— Select an InstaDDR group —</option>
                          {instaDdrGroups.map((g) => (
                            <option key={g._id} value={g._id}>
                              {g.label} ({g.totalAccounts} account{g.totalAccounts !== 1 ? "s" : ""})
                            </option>
                          ))}
                        </select>
                      )
                    )}
                  </div>
                </>
              )}
            </div>
          )}

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
                  placeholder={platform === "amazon" ? "Gift Card Claim Code" : "Gift Card Number"}
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
              {platform === "flipkart" && (
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
              )}
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
              Format:{" "}
              <code className="text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">
                {platform === "flipkart" ? "cardNumber,pin" : "claimCode"}
              </code>
              {" "}— one per line.
              {" "}Optional 3rd column: <code className="text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">status</code>
              {" "}(rows marked &quot;added&quot; are skipped)
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
              placeholder={platform === "flipkart"
                ? "XXXX-XXXX-XXXX-XXXX,123456\nYYYY-YYYY-YYYY-YYYY,654321"
                : "ABCD-EFGH-IJKL\nMNOP-QRST-UVWX"
              }
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
                <div className="flex gap-3">
                  {giftCards.some((gc) => gc.status) && (
                    <button
                      onClick={downloadCSV}
                      className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      ⬇ Download CSV
                    </button>
                  )}
                  <button
                    onClick={() => setGiftCards([])}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors"
                  >
                    Clear All
                  </button>
                </div>
              </div>
              <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="text-left px-4 py-2.5 text-gray-500 font-medium text-xs uppercase tracking-wider">#</th>
                      <th className="text-left px-4 py-2.5 text-gray-500 font-medium text-xs uppercase tracking-wider">
                        {platform === "amazon" ? "Claim Code" : "Card Number"}
                      </th>
                      {platform === "flipkart" && (
                        <th className="text-left px-4 py-2.5 text-gray-500 font-medium text-xs uppercase tracking-wider">PIN</th>
                      )}
                      <th className="text-left px-4 py-2.5 text-gray-500 font-medium text-xs uppercase tracking-wider">Status</th>
                      <th className="px-4 py-2.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {giftCards.map((gc, i) => (
                      <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                        <td className="px-4 py-2.5 text-gray-500">{i + 1}</td>
                        <td className="px-4 py-2.5 text-white font-mono">{gc.cardNumber}</td>
                        {platform === "flipkart" && (
                          <td className="px-4 py-2.5 text-white font-mono">{gc.pin}</td>
                        )}
                        <td className="px-4 py-2.5">
                          {gc.status ? (
                            <span className={`px-2.5 py-1 rounded-lg text-xs font-medium ${statusBadge(gc.status)}`}>
                              {gc.status}
                            </span>
                          ) : (
                            <span className="text-gray-600 text-xs">—</span>
                          )}
                        </td>
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
            className={`w-full py-3 ${
              platform === "amazon"
                ? "bg-orange-600 hover:bg-orange-500 shadow-orange-600/10"
                : "bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/10"
            } disabled:opacity-40 disabled:hover:bg-inherit text-white font-semibold rounded-xl transition-all shadow-lg mb-6`}
          >
            {loading
              ? `Processing ${giftCards.length} Gift Cards on ${platform === "amazon" ? "Amazon" : "Flipkart"}...`
              : `Add ${giftCards.length || 0} Gift Card${giftCards.length !== 1 ? "s" : ""} to ${platform === "amazon" ? "Amazon" : "Flipkart"}`}
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
                        : log.includes("success") || log.includes("added")
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
              {/* Stats + Download */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex gap-4">
                  <div className="p-4 bg-gray-900 rounded-xl border border-gray-800 text-center min-w-[100px]">
                    <p className="text-2xl font-bold text-white">{history.length}</p>
                    <p className="text-xs text-gray-500 mt-1">Total</p>
                  </div>
                  <div className="p-4 bg-gray-900 rounded-xl border border-gray-800 text-center min-w-[100px]">
                    <p className="text-2xl font-bold text-emerald-400">
                      {history.filter((h) => h.status === "success").length}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">Added</p>
                  </div>
                  <div className="p-4 bg-gray-900 rounded-xl border border-gray-800 text-center min-w-[100px]">
                    <p className="text-2xl font-bold text-red-400">
                      {history.filter((h) => h.status === "failed").length}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">Failed</p>
                  </div>
                </div>
                <button
                  onClick={downloadHistoryCSV}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl transition-all text-sm font-medium shadow-lg shadow-blue-600/10"
                >
                  ⬇ Download CSV
                </button>
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
                            {h.status === "success" ? "added" : h.status === "failed" ? "not added" : h.status}
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
