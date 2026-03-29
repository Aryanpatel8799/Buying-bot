"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

interface SavedCard {
  _id: string;
  label: string;
  createdAt: string;
}

export default function CardsPage() {
  const { status } = useSession();
  const router = useRouter();
  const [cards, setCards] = useState<SavedCard[]>([]);
  const [loading, setLoading] = useState(true);

  // Add card form
  const [showForm, setShowForm] = useState(false);
  const [cardNumber, setCardNumber] = useState("");
  const [expiryMonth, setExpiryMonth] = useState("01");
  const [expiryYear, setExpiryYear] = useState(String(new Date().getFullYear()));
  const [cvv, setCvv] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // CSV upload
  const [showCsv, setShowCsv] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [csvResult, setCsvResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    if (status === "authenticated") fetchCards();
  }, [status, router]);

  async function fetchCards() {
    try {
      const res = await fetch("/api/cards");
      if (res.ok) setCards(await res.json());
    } finally {
      setLoading(false);
    }
  }

  function formatCardInput(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 16);
    return digits.replace(/(.{4})/g, "$1 ").trim();
  }

  async function handleAddCard(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    const cleanNum = cardNumber.replace(/\s/g, "");
    if (cleanNum.length < 13) {
      setFormError("Card number must be at least 13 digits");
      return;
    }
    if (!cvv || cvv.length < 3) {
      setFormError("CVV must be at least 3 digits");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardNumber: cleanNum,
          expiryMonth,
          expiryYear,
          cvv,
          label: label || `Card ending ${cleanNum.slice(-4)}`,
        }),
      });
      if (res.ok) {
        setCardNumber("");
        setCvv("");
        setLabel("");
        setShowForm(false);
        setFormError("");
        fetchCards();
      } else {
        const data = await res.json();
        setFormError(data.error || "Failed to add card");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleCsvUpload() {
    if (!csvText.trim()) return;
    setUploading(true);
    setCsvResult(null);
    try {
      const res = await fetch("/api/cards/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: csvText }),
      });
      const data = await res.json();
      if (res.ok) {
        setCsvResult({
          type: "success",
          message: `Imported ${data.inserted} card(s)${data.errors?.length ? `. ${data.errors.length} error(s)` : ""}`,
        });
        setCsvText("");
        fetchCards();
      } else {
        setCsvResult({ type: "error", message: data.error || "Upload failed" });
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(cardId: string) {
    if (!confirm("Delete this card?")) return;
    const res = await fetch(`/api/cards/${cardId}`, { method: "DELETE" });
    if (res.ok) fetchCards();
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(reader.result as string);
    reader.readAsText(file);
  }

  if (status === "loading" || loading) {
    return <div className="text-gray-500 text-center py-12">Loading...</div>;
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Saved Cards</h1>
          <p className="text-sm text-gray-500 mt-0.5">Payment cards for automated checkout</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { setShowForm(!showForm); setShowCsv(false); }}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              showForm
                ? "bg-gray-800 text-gray-300 border border-gray-700"
                : "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/10"
            }`}
          >
            {showForm ? "Cancel" : "+ Add Card"}
          </button>
          <button
            onClick={() => { setShowCsv(!showCsv); setShowForm(false); }}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              showCsv
                ? "bg-gray-800 text-gray-300 border border-gray-700"
                : "bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700"
            }`}
          >
            {showCsv ? "Cancel" : "CSV Upload"}
          </button>
        </div>
      </div>

      {/* Add Card Form */}
      {showForm && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-gray-200 mb-4">Add New Card</h2>
          {formError && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm">
              {formError}
            </div>
          )}
          <form onSubmit={handleAddCard} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Label</label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g., HDFC Visa, SBI Rupay"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Card Number</label>
              <input
                type="text"
                value={cardNumber}
                onChange={(e) => setCardNumber(formatCardInput(e.target.value))}
                placeholder="1234 5678 9012 3456"
                maxLength={19}
                required
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white font-mono tracking-wider focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
              />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Month</label>
                <select
                  value={expiryMonth}
                  onChange={(e) => setExpiryMonth(e.target.value)}
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
                >
                  {Array.from({ length: 12 }, (_, i) => {
                    const m = String(i + 1).padStart(2, "0");
                    return <option key={m} value={m}>{m}</option>;
                  })}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Year</label>
                <select
                  value={expiryYear}
                  onChange={(e) => setExpiryYear(e.target.value)}
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
                >
                  {Array.from({ length: 12 }, (_, i) => {
                    const y = String(new Date().getFullYear() + i);
                    return <option key={y} value={y}>{y}</option>;
                  })}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">CVV</label>
                <input
                  type="password"
                  value={cvv}
                  onChange={(e) => setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  placeholder="***"
                  maxLength={4}
                  required
                  className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-xl text-sm font-medium transition-all text-white shadow-lg shadow-emerald-600/10"
            >
              {saving ? "Saving..." : "Save Card"}
            </button>
          </form>
        </div>
      )}

      {/* CSV Upload */}
      {showCsv && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-gray-200 mb-1">CSV Bulk Upload</h2>
          <p className="text-xs text-gray-500 mb-4">
            Format: <code className="text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">cardNumber,MM/YYYY,cvv,label</code> — one card per line
          </p>
          <div className="mb-3">
            <label className="cursor-pointer">
              <input type="file" accept=".csv,.txt" onChange={handleFileUpload} className="hidden" />
              <div className="px-4 py-2.5 bg-gray-800 border border-gray-700 border-dashed rounded-xl text-sm text-gray-400 text-center hover:border-blue-500/40 hover:text-blue-400 transition-all">
                Click to upload .csv or .txt file
              </div>
            </label>
          </div>
          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={`4111111111111111,01/2027,123,HDFC Visa\n5500000000000004,06/2028,456,SBI Master`}
            rows={5}
            className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all mb-3"
          />
          <button
            onClick={handleCsvUpload}
            disabled={uploading || !csvText.trim()}
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-xl text-sm font-medium transition-all text-white shadow-lg shadow-emerald-600/10"
          >
            {uploading ? "Uploading..." : "Upload Cards"}
          </button>
          {csvResult && (
            <div className={`mt-3 p-3 rounded-xl text-sm ${
              csvResult.type === "success"
                ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400"
                : "bg-red-500/10 border border-red-500/20 text-red-400"
            }`}>
              {csvResult.message}
            </div>
          )}
        </div>
      )}

      {/* Cards Table */}
      {cards.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <p className="text-gray-500">No saved cards yet.</p>
          <p className="text-sm text-gray-600 mt-1">Add cards to use for payment rotation in jobs.</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Label</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Added</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => (
                <tr key={card._id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-5 py-3.5 text-sm font-medium">{card.label}</td>
                  <td className="px-5 py-3.5 text-sm text-gray-500">
                    {new Date(card.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <button
                      onClick={() => handleDelete(card._id)}
                      className="text-sm text-red-400 hover:text-red-300 transition-colors font-medium"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
