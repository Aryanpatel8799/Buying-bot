"use client";

import { useState, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

interface InventorySummary {
  _id: string;
  name: string;
  platform: "flipkart" | "amazon";
  totalCodes: number;
  available: number;
  used: number;
  failed: number;
  createdAt: string;
}

interface InventoryCode {
  code: string;
  pin: string;
  balance?: number;
  status: "available" | "used" | "failed";
  errorMessage?: string;
  addedAt: string;
  usedAt?: string;
}

interface InventoryDetail extends InventorySummary {
  codes: InventoryCode[];
}

export default function GiftCardInventoryPage() {
  const { status } = useSession();
  const router = useRouter();

  const [inventories, setInventories] = useState<InventorySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"list" | "detail">("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedInventory, setSelectedInventory] = useState<InventoryDetail | null>(null);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPlatform, setNewPlatform] = useState<"flipkart" | "amazon">("flipkart");
  const [creating, setCreating] = useState(false);

  // CSV upload
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Filter
  const [filterStatus, setFilterStatus] = useState<string>("all");

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    if (status === "authenticated") fetchInventories();
  }, [status, router]);

  async function fetchInventories() {
    setLoading(true);
    try {
      const res = await fetch("/api/giftcards/inventory");
      if (res.ok) setInventories(await res.json());
    } finally {
      setLoading(false);
    }
  }

  async function createInventory() {
    if (!newName.trim()) {
      setError("Inventory name is required");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const res = await fetch("/api/giftcards/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), platform: newPlatform }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to create inventory");
        return;
      }
      const inv = await res.json();
      setInventories((prev) => [inv, ...prev]);
      setShowCreate(false);
      setNewName("");
    } catch {
      setError("Something went wrong");
    } finally {
      setCreating(false);
    }
  }

  async function openInventory(id: string) {
    setSelectedId(id);
    setActiveTab("detail");
    setFilterStatus("all");
    const res = await fetch(`/api/giftcards/inventory/${id}`);
    if (res.ok) {
      setSelectedInventory(await res.json());
    }
  }

  async function uploadCSV() {
    if (!csvFile || !selectedId) return;
    setUploading(true);
    setUploadResult("");
    setError("");
    try {
      const formData = new FormData();
      formData.append("file", csvFile);
      const res = await fetch(`/api/giftcards/inventory/${selectedId}/bulk`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Upload failed");
        return;
      }
      setUploadResult(`Added ${data.added} codes${data.skipped > 0 ? `, skipped ${data.skipped} duplicates` : ""}`);
      setCsvFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      // Refresh detail
      const detailRes = await fetch(`/api/giftcards/inventory/${selectedId}`);
      if (detailRes.ok) setSelectedInventory(await detailRes.json());
      // Refresh list
      fetchInventories();
    } catch {
      setError("Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function deleteInventory(id: string) {
    if (!confirm("Delete this inventory and all its codes?")) return;
    const res = await fetch(`/api/giftcards/inventory/${id}`, { method: "DELETE" });
    if (res.ok) {
      setInventories((prev) => prev.filter((i) => i._id !== id));
      if (selectedId === id) {
        setSelectedId(null);
        setSelectedInventory(null);
        setActiveTab("list");
      }
    }
  }

  async function deleteCode(index: number) {
    if (!selectedId) return;
    const res = await fetch(`/api/giftcards/inventory/${selectedId}/codes/${index}`, { method: "DELETE" });
    if (res.ok) {
      setSelectedInventory((prev) => {
        if (!prev) return null;
        const codes = [...prev.codes];
        codes.splice(index, 1);
        return { ...prev, codes, totalCodes: codes.length };
      });
      fetchInventories();
    }
  }

  async function downloadExport() {
    if (!selectedId || !selectedInventory) return;
    const res = await fetch(`/api/giftcards/inventory/${selectedId}/export`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedInventory.name.replace(/[^a-zA-Z0-9_-]/g, "_")}_${selectedInventory.platform}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function maskCode(code: string) {
    if (code.length <= 8) return code.slice(0, 2) + "****" + code.slice(-2);
    return code.slice(0, 4) + "****" + code.slice(-4);
  }

  const filteredCodes = selectedInventory
    ? filterStatus === "all"
      ? selectedInventory.codes
      : selectedInventory.codes.filter((c) => c.status === filterStatus)
    : [];

  const statusBadge = (s: string) => {
    switch (s) {
      case "available":
        return "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
      case "used":
        return "bg-gray-500/10 text-gray-400 border border-gray-500/20";
      case "failed":
        return "bg-red-500/10 text-red-400 border border-red-500/20";
      default:
        return "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20";
    }
  };

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1">
          <button
            onClick={() => {
              setActiveTab("list");
              setSelectedId(null);
              setSelectedInventory(null);
            }}
            className="text-gray-500 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-2xl font-bold">Gift Card Inventory</h1>
        </div>
        <p className="text-sm text-gray-400 ml-8">
          Manage gift card code lists for use in checkout jobs
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm flex items-start gap-2">
          <span className="shrink-0 mt-0.5">&#x2715;</span>
          <span>{error}</span>
        </div>
      )}

      {/* List View */}
      {activeTab === "list" && (
        <>
          <div className="flex items-center justify-between mb-6">
            <p className="text-sm text-gray-500">
              {loading ? "Loading..." : (
                <>
                  {inventories.filter((i) => i.platform === "flipkart").length > 0 && (
                    <span className="text-blue-400">{inventories.filter((i) => i.platform === "flipkart").length} Flipkart</span>
                  )}
                  {inventories.filter((i) => i.platform === "flipkart").length > 0 && inventories.filter((i) => i.platform === "amazon").length > 0 && <span className="text-gray-600 mx-2">/</span>}
                  {inventories.filter((i) => i.platform === "amazon").length > 0 && (
                    <span className="text-orange-400">{inventories.filter((i) => i.platform === "amazon").length} Amazon</span>
                  )}
                  {" "}list{inventories.length !== 1 ? "s" : ""}
                </>
              )}
            </p>
            <button
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-all shadow-lg shadow-blue-600/10"
            >
              + New List
            </button>
          </div>

          {/* Create Form */}
          {showCreate && (
            <div className="mb-6 p-5 bg-gray-900 rounded-xl border border-gray-800">
              <h3 className="text-sm font-semibold text-gray-200 mb-4">Create New List</h3>
              <div className="flex gap-3 items-end">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-400 mb-1 uppercase tracking-wider">Name</label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g., March 2026 Codes"
                    className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition-all"
                    onKeyDown={(e) => e.key === "Enter" && createInventory()}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1 uppercase tracking-wider">Platform</label>
                  <select
                    value={newPlatform}
                    onChange={(e) => setNewPlatform(e.target.value as "flipkart" | "amazon")}
                    className="px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition-all"
                  >
                    <option value="flipkart">Flipkart</option>
                    <option value="amazon">Amazon</option>
                  </select>
                </div>
                <button
                  onClick={createInventory}
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

          {/* Inventories Grid */}
          {loading ? (
            <div className="text-center py-16 text-gray-500">Loading...</div>
          ) : inventories.length === 0 && !showCreate ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-16 text-center">
              <p className="text-gray-500 mb-4">No inventory lists yet.</p>
              <button
                onClick={() => setShowCreate(true)}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-all"
              >
                Create your first list
              </button>
            </div>
          ) : (
            <>
              {/* Flipkart Section */}
              {inventories.filter((i) => i.platform === "flipkart").length > 0 && (
                <div className="mb-8">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="text-xs px-2.5 py-1 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20 font-semibold uppercase tracking-wider">Flipkart</span>
                    <div className="flex-1 h-px bg-gray-800" />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {inventories.filter((i) => i.platform === "flipkart").map((inv) => (
                      <div
                        key={inv._id}
                        className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition-all cursor-pointer"
                        onClick={() => openInventory(inv._id)}
                      >
                        <div className="flex items-start justify-between mb-3">
                          <div>
                            <h3 className="text-sm font-semibold text-white">{inv.name}</h3>
                            <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded border font-medium bg-blue-500/10 text-blue-400 border-blue-500/20">
                              Flipkart
                            </span>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteInventory(inv._id); }}
                            className="text-red-400/60 hover:text-red-400 transition-colors p-1"
                            title="Delete inventory"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                        <div className="flex gap-4 text-xs">
                          <div className="text-center">
                            <p className="text-xl font-bold text-white">{inv.totalCodes}</p>
                            <p className="text-gray-500 mt-0.5">Total</p>
                          </div>
                          <div className="text-center">
                            <p className="text-xl font-bold text-emerald-400">{inv.available}</p>
                            <p className="text-gray-500 mt-0.5">Available</p>
                          </div>
                          <div className="text-center">
                            <p className="text-xl font-bold text-gray-400">{inv.used}</p>
                            <p className="text-gray-500 mt-0.5">Used</p>
                          </div>
                          <div className="text-center">
                            <p className="text-xl font-bold text-red-400">{inv.failed}</p>
                            <p className="text-gray-500 mt-0.5">Failed</p>
                          </div>
                        </div>
                        <p className="text-xs text-gray-600 mt-3">
                          Created {new Date(inv.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Amazon Section */}
              {inventories.filter((i) => i.platform === "amazon").length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-4">
                    <span className="text-xs px-2.5 py-1 rounded-lg bg-orange-500/10 text-orange-400 border border-orange-500/20 font-semibold uppercase tracking-wider">Amazon</span>
                    <div className="flex-1 h-px bg-gray-800" />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {inventories.filter((i) => i.platform === "amazon").map((inv) => (
                      <div
                        key={inv._id}
                        className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition-all cursor-pointer"
                        onClick={() => openInventory(inv._id)}
                      >
                        <div className="flex items-start justify-between mb-3">
                          <div>
                            <h3 className="text-sm font-semibold text-white">{inv.name}</h3>
                            <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded border font-medium bg-orange-500/10 text-orange-400 border-orange-500/20">
                              Amazon
                            </span>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteInventory(inv._id); }}
                            className="text-red-400/60 hover:text-red-400 transition-colors p-1"
                            title="Delete inventory"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                        <div className="flex gap-4 text-xs">
                          <div className="text-center">
                            <p className="text-xl font-bold text-white">{inv.totalCodes}</p>
                            <p className="text-gray-500 mt-0.5">Total</p>
                          </div>
                          <div className="text-center">
                            <p className="text-xl font-bold text-emerald-400">{inv.available}</p>
                            <p className="text-gray-500 mt-0.5">Available</p>
                          </div>
                          <div className="text-center">
                            <p className="text-xl font-bold text-gray-400">{inv.used}</p>
                            <p className="text-gray-500 mt-0.5">Used</p>
                          </div>
                          <div className="text-center">
                            <p className="text-xl font-bold text-red-400">{inv.failed}</p>
                            <p className="text-gray-500 mt-0.5">Failed</p>
                          </div>
                        </div>
                        <p className="text-xs text-gray-600 mt-3">
                          Created {new Date(inv.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Detail View */}
      {activeTab === "detail" && selectedInventory && (
        <>
          {/* Detail Header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-lg font-semibold text-white">{selectedInventory.name}</h2>
              <span className={`inline-block mt-1 text-xs px-2 py-0.5 rounded border font-medium ${
                selectedInventory.platform === "amazon"
                  ? "bg-orange-500/10 text-orange-400 border-orange-500/20"
                  : "bg-blue-500/10 text-blue-400 border-blue-500/20"
              }`}>
                {selectedInventory.platform === "amazon" ? "Amazon" : "Flipkart"}
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
                  if (selectedId) fetch(`/api/giftcards/inventory/${selectedId}`).then((r) => { if (r.ok) r.json().then(setSelectedInventory); });
                  fetchInventories();
                }}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-all shadow-lg shadow-blue-600/10"
              >
                Refresh
              </button>
            </div>
          </div>

          {/* Stats */}
          <div className="flex gap-4 mb-6">
            {[
              { label: "Total", value: selectedInventory.totalCodes, color: "text-white" },
              { label: "Available", value: selectedInventory.available, color: "text-emerald-400" },
              { label: "Used", value: selectedInventory.used, color: "text-gray-400" },
              { label: "Failed", value: selectedInventory.failed, color: "text-red-400" },
            ].map((stat) => (
              <div key={stat.label} className="bg-gray-900 border border-gray-800 rounded-xl px-5 py-3 text-center min-w-[80px]">
                <p className={`text-2xl font-bold ${stat.color}`}>{stat.value}</p>
                <p className="text-xs text-gray-500 mt-0.5">{stat.label}</p>
              </div>
            ))}
          </div>

          {/* CSV Upload */}
          <div className="mb-6 p-5 bg-gray-900 rounded-xl border border-gray-800">
            <h3 className="text-sm font-semibold text-gray-200 mb-3">Upload Codes (CSV)</h3>
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
              Format: <code className="bg-gray-800 px-1 rounded">code,pin</code> — header row optional. Duplicates are skipped.
            </p>
          </div>

          {/* Filter */}
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xs text-gray-500">Filter:</span>
            {["all", "available", "used", "failed"].map((f) => (
              <button
                key={f}
                onClick={() => setFilterStatus(f)}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                  filterStatus === f
                    ? "bg-blue-600 text-white"
                    : "bg-gray-900 text-gray-400 border border-gray-800 hover:border-gray-700"
                }`}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
                {f !== "all" && selectedInventory && (
                  <span className="ml-1 opacity-60">
                    ({selectedInventory.codes.filter((c) => c.status === f).length})
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Codes Table */}
          {filteredCodes.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
              <p className="text-gray-500">
                {filterStatus === "all" ? "No codes in this inventory yet." : `No ${filterStatus} codes.`}
              </p>
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <table className="w-full text-sm table-fixed">
                <thead>
                  <tr className="border-b border-gray-800 bg-gray-900 sticky top-0 z-10">
                    <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider w-12">#</th>
                    <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider">Code</th>
                    {selectedInventory.platform === "flipkart" && (
                      <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider w-40">PIN</th>
                    )}
                    <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider w-24">Status</th>
                    <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider">Error</th>
                    <th className="text-left px-4 py-3 text-gray-500 font-medium text-xs uppercase tracking-wider w-36">Used At</th>
                    <th className="px-4 py-3 w-16"></th>
                  </tr>
                </thead>
              </table>
              <div className="overflow-y-auto" style={{ maxHeight: "500px" }}>
                <table className="w-full text-sm table-fixed">
                  <tbody>
                    {filteredCodes.map((code, i) => {
                      const originalIdx = selectedInventory!.codes.indexOf(code);
                      return (
                        <tr key={originalIdx} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                          <td className="px-4 py-3 text-gray-500">{originalIdx + 1}</td>
                          <td className="px-4 py-3 text-white font-mono truncate">{maskCode(code.code)}</td>
                          {selectedInventory!.platform === "flipkart" && (
                            <td className="px-4 py-3 text-white font-mono truncate">{code.pin || "—"}</td>
                          )}
                          <td className="px-4 py-3">
                            <span className={`px-2.5 py-1 rounded-lg text-xs font-medium ${statusBadge(code.status)}`}>
                              {code.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-red-400 max-w-32 truncate">
                            {code.errorMessage || "—"}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500">
                            {code.usedAt ? new Date(code.usedAt).toLocaleString() : "—"}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => deleteCode(originalIdx)}
                              className="text-red-400/60 hover:text-red-400 transition-colors text-xs"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-600">
                Showing {filteredCodes.length} of {selectedInventory!.codes.length} codes — scroll for more
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
