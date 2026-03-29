"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

interface SavedAccount {
  _id: string;
  label: string;
  maskedEmail: string;
  createdAt: string;
}

export default function AccountsPage() {
  const { status } = useSession();
  const router = useRouter();
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [loading, setLoading] = useState(true);

  // Add account form
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState("");
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
    if (status === "authenticated") fetchAccounts();
  }, [status, router]);

  async function fetchAccounts() {
    try {
      const res = await fetch("/api/accounts");
      if (res.ok) setAccounts(await res.json());
    } finally {
      setLoading(false);
    }
  }

  async function handleAddAccount(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFormError("Please enter a valid email address");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          label: label || email,
        }),
      });
      if (res.ok) {
        setEmail("");
        setLabel("");
        setShowForm(false);
        setFormError("");
        fetchAccounts();
      } else {
        const data = await res.json();
        setFormError(data.error || "Failed to add account");
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
      const res = await fetch("/api/accounts/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: csvText }),
      });
      const data = await res.json();
      if (res.ok) {
        setCsvResult({
          type: "success",
          message: `Imported ${data.inserted} account(s)${data.errors?.length ? `. ${data.errors.length} error(s)` : ""}`,
        });
        setCsvText("");
        fetchAccounts();
      } else {
        setCsvResult({ type: "error", message: data.error || "Upload failed" });
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(accountId: string) {
    if (!confirm("Delete this account?")) return;
    const res = await fetch(`/api/accounts/${accountId}`, { method: "DELETE" });
    if (res.ok) fetchAccounts();
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
          <h1 className="text-2xl font-bold">Flipkart Accounts</h1>
          <p className="text-sm text-gray-500 mt-0.5">Accounts for multi-account rotation</p>
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
            {showForm ? "Cancel" : "+ Add Account"}
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

      {/* Add Account Form */}
      {showForm && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-gray-200 mb-4">Add Flipkart Account</h2>
          {formError && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm">
              {formError}
            </div>
          )}
          <form onSubmit={handleAddAccount} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@example.com"
                required
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">Label (optional)</label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g., Account 1, Main Account"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
              />
            </div>
            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-xl text-sm font-medium transition-all text-white shadow-lg shadow-emerald-600/10"
            >
              {saving ? "Saving..." : "Save Account"}
            </button>
          </form>
        </div>
      )}

      {/* CSV Upload */}
      {showCsv && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-gray-200 mb-1">CSV Bulk Upload</h2>
          <p className="text-xs text-gray-500 mb-4">
            Format: <code className="text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">email,label</code> or just <code className="text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">email</code> — one account per line
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
            placeholder={`user1@gmail.com,Account 1\nuser2@gmail.com,Account 2\nuser3@gmail.com`}
            rows={5}
            className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all mb-3"
          />
          <button
            onClick={handleCsvUpload}
            disabled={uploading || !csvText.trim()}
            className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-xl text-sm font-medium transition-all text-white shadow-lg shadow-emerald-600/10"
          >
            {uploading ? "Uploading..." : "Upload Accounts"}
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

      {/* Accounts Table */}
      {accounts.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <p className="text-gray-500">No saved accounts yet.</p>
          <p className="text-sm text-gray-600 mt-1">Add Flipkart accounts for multi-account rotation in jobs.</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Label</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
                <th className="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Added</th>
                <th className="text-right px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((acc) => (
                <tr key={acc._id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-5 py-3.5 text-sm font-medium">{acc.label}</td>
                  <td className="px-5 py-3.5 text-sm text-gray-400 font-mono">{acc.maskedEmail}</td>
                  <td className="px-5 py-3.5 text-sm text-gray-500">
                    {new Date(acc.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <button
                      onClick={() => handleDelete(acc._id)}
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
