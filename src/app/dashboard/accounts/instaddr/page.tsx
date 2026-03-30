"use client";

import { useState, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

interface InstaDdrGroupSummary {
  _id: string;
  label: string;
  platform: string;
  totalAccounts: number;
  createdAt: string;
}

interface InstaDdrAccountEntry {
  _id: string;
  instaDdrId: string;
  instaDdrPassword: string;
  email: string;
  createdAt: string;
}

interface InstaDdrGroupDetail extends InstaDdrGroupSummary {
  accounts: InstaDdrAccountEntry[];
}

export default function InstaDdrPage() {
  const { status } = useSession();
  const router = useRouter();

  const [groups, setGroups] = useState<InstaDdrGroupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState<"list" | "detail">("list");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<InstaDdrGroupDetail | null>(null);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [creating, setCreating] = useState(false);

  // CSV upload
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    if (status === "authenticated") fetchGroups();
  }, [status, router]);

  async function fetchGroups() {
    setLoading(true);
    try {
      const res = await fetch("/api/instaddr");
      if (res.ok) setGroups(await res.json());
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }

  async function createGroup() {
    if (!newLabel.trim()) { setError("Group name is required"); return; }
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/instaddr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: newLabel.trim(), platform: "flipkart" }),
      });
      if (!res.ok) { const d = await res.json(); setError(d.error || "Failed"); return; }
      const g = await res.json();
      setGroups((prev) => [g, ...prev]);
      setShowCreate(false);
      setNewLabel("");
    } catch { setError("Something went wrong"); } finally { setCreating(false); }
  }

  async function openGroup(id: string) {
    setSelectedGroupId(id);
    setView("detail");
    const res = await fetch(`/api/instaddr/${id}`);
    if (res.ok) setSelectedGroup(await res.json());
  }

  async function uploadCSV() {
    if (!csvFile || !selectedGroupId) return;
    setUploading(true);
    setUploadResult("");
    setError("");
    try {
      const text = await csvFile.text();
      const res = await fetch(`/api/instaddr/${selectedGroupId}/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: text }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Upload failed"); return; }
      setUploadResult(`Added ${data.inserted} accounts${data.errors?.length ? `, ${data.errors.length} errors` : ""}`);
      setCsvFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      // Refresh detail
      const detailRes = await fetch(`/api/instaddr/${selectedGroupId}`);
      if (detailRes.ok) setSelectedGroup(await detailRes.json());
      fetchGroups();
    } catch { setError("Upload failed"); } finally { setUploading(false); }
  }

  async function deleteGroup(id: string) {
    if (!confirm("Delete this InstaDDR group and all its accounts?")) return;
    const res = await fetch(`/api/instaddr/${id}`, { method: "DELETE" });
    if (res.ok) {
      setGroups((prev) => prev.filter((g) => g._id !== id));
      if (selectedGroupId === id) {
        setSelectedGroupId(null);
        setSelectedGroup(null);
        setView("list");
      }
    }
  }

  async function deleteAccount(accountId: string) {
    if (!selectedGroupId) return;
    const res = await fetch(`/api/instaddr/${selectedGroupId}/accounts/${accountId}`, { method: "DELETE" });
    if (res.ok) {
      setSelectedGroup((prev) => {
        if (!prev) return null;
        return { ...prev, accounts: prev.accounts.filter((a) => a._id !== accountId) };
      });
      fetchGroups();
    }
  }

  async function downloadExport() {
    if (!selectedGroupId) return;
    const res = await fetch(`/api/instaddr/${selectedGroupId}/export`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedGroup?.label?.replace(/[^a-zA-Z0-9_-]/g, "_") || "instaddr"}_accounts.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function mask(str: string): string {
    if (!str || str === "****") return "****";
    if (str.length <= 4) return "****";
    return str.slice(0, 2) + "****" + str.slice(-2);
  }

  // Group accounts by InstaDDR ID for display
  const groupedByInstaDdr = selectedGroup
    ? selectedGroup.accounts.reduce<Record<string, InstaDdrAccountEntry[]>>((acc, a) => {
        const key = a.instaDdrId || "Unknown";
        if (!acc[key]) acc[key] = [];
        acc[key].push(a);
        return acc;
      }, {})
    : {};

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          {view === "detail" && (
            <button
              onClick={() => { setView("list"); setSelectedGroupId(null); setSelectedGroup(null); }}
              className="text-gray-500 hover:text-white transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          <h1 className="text-2xl font-bold">InstaDDR Accounts</h1>
        </div>
        <p className="text-sm text-gray-400 ml-8">
          Manage InstaDDR accounts for automated OTP retrieval during Flipkart ordering
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm flex items-start gap-2">
          <span className="shrink-0 mt-0.5">&#x2715;</span>
          <span>{error}</span>
        </div>
      )}

      {/* List View */}
      {view === "list" && (
        <>
          <div className="flex items-center justify-between mb-6">
            <p className="text-sm text-gray-500">
              {loading ? "Loading..." : `${groups.length} group${groups.length !== 1 ? "s" : ""}`}
            </p>
            <button
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-all shadow-lg shadow-blue-600/10"
            >
              + New Group
            </button>
          </div>

          {showCreate && (
            <div className="mb-6 p-5 bg-gray-900 rounded-xl border border-gray-800">
              <h3 className="text-sm font-semibold text-gray-200 mb-4">Create New Group</h3>
              <div className="flex gap-3 items-end">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-400 mb-1 uppercase tracking-wider">Group Name</label>
                  <input
                    type="text"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="e.g. March 2026 OTP Accounts"
                    className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                    onKeyDown={(e) => e.key === "Enter" && createGroup()}
                  />
                </div>
                <button
                  onClick={createGroup}
                  disabled={creating}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-all"
                >
                  {creating ? "Creating..." : "Create"}
                </button>
                <button
                  onClick={() => { setShowCreate(false); setError(""); }}
                  className="px-4 py-2.5 text-gray-400 hover:text-white text-sm transition-all"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="text-center py-16 text-gray-500">Loading...</div>
          ) : groups.length === 0 && !showCreate ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-16 text-center">
              <p className="text-gray-500 mb-4">No InstaDDR groups yet.</p>
              <button
                onClick={() => setShowCreate(true)}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-all"
              >
                Create your first group
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {groups.map((g) => (
                <div
                  key={g._id}
                  className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition-all cursor-pointer"
                  onClick={() => openGroup(g._id)}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="text-sm font-semibold text-white">{g.label}</h3>
                      <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded border font-medium bg-blue-500/10 text-blue-400 border-blue-500/20">
                        Flipkart OTP
                      </span>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteGroup(g._id); }}
                      className="text-red-400/60 hover:text-red-400 transition-colors p-1"
                      title="Delete group"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                  <div className="flex gap-4 text-xs">
                    <div className="text-center">
                      <p className="text-xl font-bold text-white">{g.totalAccounts}</p>
                      <p className="text-gray-500 mt-0.5">Accounts</p>
                    </div>
                  </div>
                  <p className="text-xs text-gray-600 mt-3">
                    Created {new Date(g.createdAt).toLocaleDateString()}
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Detail View */}
      {view === "detail" && selectedGroup && (
        <>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-lg font-semibold text-white">{selectedGroup.label}</h2>
              <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded border font-medium bg-blue-500/10 text-blue-400 border-blue-500/20">
                Flipkart OTP
              </span>
            </div>
            <div className="flex gap-2 items-center">
              <button
                onClick={downloadExport}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-white text-sm font-medium rounded-xl transition-all"
              >
                Download CSV
              </button>
              <button
                onClick={() => {
                  if (selectedGroupId) fetch(`/api/instaddr/${selectedGroupId}`).then((r) => { if (r.ok) r.json().then(setSelectedGroup); });
                  fetchGroups();
                }}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-all shadow-lg shadow-blue-600/10"
              >
                Refresh
              </button>
            </div>
          </div>

          {/* Stats */}
          <div className="flex gap-4 mb-6">
            <div className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-3 text-center min-w-[80px]">
              <p className="text-2xl font-bold text-white">{selectedGroup.totalAccounts}</p>
              <p className="text-xs text-gray-500 mt-0.5">Total</p>
            </div>
          </div>

          {/* CSV Upload */}
          <div className="mb-6 p-5 bg-gray-900 rounded-xl border border-gray-800">
            <h3 className="text-sm font-semibold text-gray-200 mb-3">Upload Accounts (CSV)</h3>
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="flex-1 cursor-pointer">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.txt"
                    onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)}
                    className="hidden"
                  />
                  <div className="px-4 py-2.5 bg-gray-800 border border-gray-700 border-dashed rounded-xl text-sm text-gray-400 text-center hover:border-blue-500/40 hover:text-blue-400 transition-all">
                    {csvFile ? csvFile.name : "Click to select .csv or .txt file"}
                  </div>
                </label>
              </div>
              <button
                onClick={uploadCSV}
                disabled={!csvFile || uploading}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-all"
              >
                {uploading ? "Uploading..." : "Upload"}
              </button>
            </div>
            {uploadResult && (
              <p className="text-xs text-emerald-400 mt-2">{uploadResult}</p>
            )}
            <p className="text-xs text-gray-600 mt-2">
              Format: <code className="bg-gray-800 px-1 rounded">instaDdrId,password,email</code> — header optional. Duplicates are skipped.
            </p>
          </div>

          {/* Accounts Table */}
          {selectedGroup.accounts.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
              <p className="text-gray-500">No accounts in this group yet.</p>
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <table className="w-full text-sm table-fixed">
                <thead>
                  <tr className="border-b border-gray-800 bg-gray-900 sticky top-0 z-10">
                    <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider w-12">#</th>
                    <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider">InstaDDR ID</th>
                    <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider">Password</th>
                    <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider">Email</th>
                    <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider">Added</th>
                    <th className="px-4 py-3 w-16"></th>
                  </tr>
                </thead>
              </table>
              <div className="overflow-y-auto" style={{ maxHeight: "500px" }}>
                <table className="w-full text-sm table-fixed">
                  <tbody>
                    {selectedGroup.accounts.map((a, i) => (
                      <tr key={a._id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                        <td className="px-4 py-3 text-gray-500">{i + 1}</td>
                        <td className="px-4 py-3 text-white font-mono truncate">{a.instaDdrId}</td>
                        <td className="px-4 py-3 text-white font-mono">{a.instaDdrPassword}</td>
                        <td className="px-4 py-3 text-white font-mono truncate">{a.email}</td>
                        <td className="px-4 py-3 text-xs text-gray-500">
                          {new Date(a.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => deleteAccount(a._id)}
                            className="text-red-400/60 hover:text-red-400 transition-colors text-xs"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-600">
                Showing {selectedGroup.accounts.length} accounts
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
