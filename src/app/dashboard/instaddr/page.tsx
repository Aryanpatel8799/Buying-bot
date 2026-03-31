"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

interface InstaDdrAccountItem {
  _id: string;
  instaDdrId: string;
  instaDdrPassword: string;
  email: string;
  createdAt: string;
}

interface InstaDdrGroup {
  _id: string;
  label: string;
  platform: string;
  totalAccounts: number;
  accounts?: InstaDdrAccountItem[];
  createdAt: string;
  updatedAt: string;
}

export default function InstaDdrPage() {
  const { status } = useSession();
  const router = useRouter();
  const [groups, setGroups] = useState<InstaDdrGroup[]>([]);
  const [loading, setLoading] = useState(true);

  // Create group form
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [groupLabel, setGroupLabel] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);

  // Expanded group (shows accounts)
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [expandedGroup, setExpandedGroup] = useState<InstaDdrGroup | null>(null);
  const [loadingGroup, setLoadingGroup] = useState(false);

  // Add account form
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [instaDdrId, setInstaDdrId] = useState("");
  const [instaDdrPassword, setInstaDdrPassword] = useState("");
  const [email, setEmail] = useState("");
  const [addingAccount, setAddingAccount] = useState(false);
  const [accountError, setAccountError] = useState("");

  // CSV upload
  const [showCsv, setShowCsv] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [csvResult, setCsvResult] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    if (status === "authenticated") fetchGroups();
  }, [status, router]);

  async function fetchGroups() {
    try {
      const res = await fetch("/api/instaddr");
      if (res.ok) setGroups(await res.json());
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateGroup(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    if (!groupLabel.trim()) {
      setFormError("Label is required");
      return;
    }
    setCreatingGroup(true);
    try {
      const res = await fetch("/api/instaddr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: groupLabel.trim(), platform: "flipkart" }),
      });
      if (res.ok) {
        setGroupLabel("");
        setShowCreateGroup(false);
        fetchGroups();
      } else {
        const data = await res.json();
        setFormError(data.error || "Failed to create group");
      }
    } finally {
      setCreatingGroup(false);
    }
  }

  async function handleDeleteGroup(groupId: string) {
    if (!confirm("Delete this group and all its accounts?")) return;
    const res = await fetch(`/api/instaddr/${groupId}`, { method: "DELETE" });
    if (res.ok) {
      if (expandedGroupId === groupId) {
        setExpandedGroupId(null);
        setExpandedGroup(null);
      }
      fetchGroups();
    }
  }

  async function toggleGroup(groupId: string) {
    if (expandedGroupId === groupId) {
      setExpandedGroupId(null);
      setExpandedGroup(null);
      setShowAddAccount(false);
      setShowCsv(false);
      return;
    }
    setExpandedGroupId(groupId);
    setShowAddAccount(false);
    setShowCsv(false);
    setLoadingGroup(true);
    try {
      const res = await fetch(`/api/instaddr/${groupId}`);
      if (res.ok) {
        setExpandedGroup(await res.json());
      }
    } finally {
      setLoadingGroup(false);
    }
  }

  async function handleAddAccount(e: React.FormEvent) {
    e.preventDefault();
    setAccountError("");
    if (!instaDdrId.trim() || !instaDdrPassword.trim() || !email.trim()) {
      setAccountError("All fields are required");
      return;
    }
    setAddingAccount(true);
    try {
      const res = await fetch(`/api/instaddr/${expandedGroupId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instaDdrId: instaDdrId.trim(),
          instaDdrPassword: instaDdrPassword.trim(),
          email: email.trim(),
        }),
      });
      if (res.ok) {
        setInstaDdrId("");
        setInstaDdrPassword("");
        setEmail("");
        setShowAddAccount(false);
        setAccountError("");
        // Refresh group details
        toggleGroup(expandedGroupId!);
        fetchGroups();
      } else {
        const data = await res.json();
        setAccountError(data.error || "Failed to add account");
      }
    } finally {
      setAddingAccount(false);
    }
  }

  async function handleDeleteAccount(accountId: string) {
    if (!confirm("Delete this account?")) return;
    const res = await fetch(`/api/instaddr/${expandedGroupId}/accounts/${accountId}`, {
      method: "DELETE",
    });
    if (res.ok) {
      toggleGroup(expandedGroupId!);
      fetchGroups();
    }
  }

  async function handleCsvUpload() {
    if (!csvText.trim() || !expandedGroupId) return;
    setUploading(true);
    setCsvResult(null);
    try {
      const res = await fetch(`/api/instaddr/${expandedGroupId}/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: csvText }),
      });
      const data = await res.json();
      if (res.ok) {
        setCsvResult({
          type: "success",
          message: `Imported ${data.inserted} account(s)${data.skipped ? `, ${data.skipped} skipped` : ""}${data.errors?.length ? `. ${data.errors.length} error(s)` : ""}`,
        });
        setCsvText("");
        toggleGroup(expandedGroupId);
        fetchGroups();
      } else {
        setCsvResult({ type: "error", message: data.error || "Upload failed" });
      }
    } finally {
      setUploading(false);
    }
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
          <h1 className="text-2xl font-bold">InstaDDR Accounts</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage InstaDDR account groups for automated OTP fetching</p>
        </div>
        <button
          onClick={() => { setShowCreateGroup(!showCreateGroup); setFormError(""); }}
          className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
            showCreateGroup
              ? "bg-gray-800 text-gray-300 border border-gray-700"
              : "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/10"
          }`}
        >
          {showCreateGroup ? "Cancel" : "+ New Group"}
        </button>
      </div>

      {/* Create Group Form */}
      {showCreateGroup && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-gray-200 mb-4">Create New Group</h2>
          {formError && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm">
              {formError}
            </div>
          )}
          <form onSubmit={handleCreateGroup} className="flex gap-3">
            <input
              type="text"
              value={groupLabel}
              onChange={(e) => setGroupLabel(e.target.value)}
              placeholder="Group label (e.g., Flipkart Group 1)"
              className="flex-1 px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
            />
            <button
              type="submit"
              disabled={creatingGroup}
              className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-xl text-sm font-medium transition-all text-white shadow-lg shadow-emerald-600/10"
            >
              {creatingGroup ? "Creating..." : "Create"}
            </button>
          </form>
        </div>
      )}

      {/* Groups List */}
      {groups.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <p className="text-gray-500">No InstaDDR groups yet.</p>
          <p className="text-sm text-gray-600 mt-1">Create a group and add accounts for automated OTP fetching.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <div key={group._id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              {/* Group Header */}
              <div
                className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-gray-800/30 transition-colors"
                onClick={() => toggleGroup(group._id)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-gray-500 text-sm">
                    {expandedGroupId === group._id ? "\u25BC" : "\u25B6"}
                  </span>
                  <div>
                    <span className="font-medium text-white">{group.label}</span>
                    <span className="ml-3 text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">
                      {group.totalAccounts} account{group.totalAccounts !== 1 ? "s" : ""}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-600">
                    {new Date(group.createdAt).toLocaleDateString()}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteGroup(group._id); }}
                    className="text-sm text-red-400 hover:text-red-300 transition-colors font-medium"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* Expanded Group Details */}
              {expandedGroupId === group._id && (
                <div className="border-t border-gray-800 px-5 py-4">
                  {loadingGroup ? (
                    <div className="text-gray-500 text-sm text-center py-4">Loading accounts...</div>
                  ) : (
                    <>
                      {/* Action Buttons */}
                      <div className="flex gap-2 mb-4">
                        <button
                          onClick={() => { setShowAddAccount(!showAddAccount); setShowCsv(false); setAccountError(""); }}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                            showAddAccount
                              ? "bg-gray-800 text-gray-300 border border-gray-700"
                              : "bg-blue-600 hover:bg-blue-500 text-white"
                          }`}
                        >
                          {showAddAccount ? "Cancel" : "+ Add Account"}
                        </button>
                        <button
                          onClick={() => { setShowCsv(!showCsv); setShowAddAccount(false); setCsvResult(null); }}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                            showCsv
                              ? "bg-gray-800 text-gray-300 border border-gray-700"
                              : "bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700"
                          }`}
                        >
                          {showCsv ? "Cancel" : "CSV Upload"}
                        </button>
                      </div>

                      {/* Add Account Form */}
                      {showAddAccount && (
                        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 mb-4">
                          <h3 className="text-xs font-semibold text-gray-300 mb-3 uppercase tracking-wider">Add Account</h3>
                          {accountError && (
                            <div className="mb-3 p-2.5 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-xs">
                              {accountError}
                            </div>
                          )}
                          <form onSubmit={handleAddAccount} className="space-y-3">
                            <div className="grid grid-cols-3 gap-3">
                              <div>
                                <label className="block text-xs font-medium text-gray-400 mb-1">InstaDDR ID</label>
                                <input
                                  type="text"
                                  value={instaDdrId}
                                  onChange={(e) => setInstaDdrId(e.target.value)}
                                  placeholder="Account ID"
                                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition-all"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-gray-400 mb-1">Password</label>
                                <input
                                  type="password"
                                  value={instaDdrPassword}
                                  onChange={(e) => setInstaDdrPassword(e.target.value)}
                                  placeholder="Password"
                                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition-all"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-gray-400 mb-1">Email</label>
                                <input
                                  type="email"
                                  value={email}
                                  onChange={(e) => setEmail(e.target.value)}
                                  placeholder="email@example.com"
                                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition-all"
                                />
                              </div>
                            </div>
                            <button
                              type="submit"
                              disabled={addingAccount}
                              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-xs font-medium transition-all text-white"
                            >
                              {addingAccount ? "Adding..." : "Add Account"}
                            </button>
                          </form>
                        </div>
                      )}

                      {/* CSV Upload */}
                      {showCsv && (
                        <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 mb-4">
                          <h3 className="text-xs font-semibold text-gray-300 mb-1 uppercase tracking-wider">CSV Bulk Upload</h3>
                          <p className="text-xs text-gray-500 mb-3">
                            Format: <code className="text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">instaDdrId,instaDdrPassword,email</code> — one per line
                          </p>
                          <div className="mb-2">
                            <label className="cursor-pointer">
                              <input type="file" accept=".csv,.txt" onChange={handleFileUpload} className="hidden" />
                              <div className="px-3 py-2 bg-gray-800 border border-gray-700 border-dashed rounded-lg text-xs text-gray-400 text-center hover:border-blue-500/40 hover:text-blue-400 transition-all">
                                Click to upload .csv or .txt file
                              </div>
                            </label>
                          </div>
                          <textarea
                            value={csvText}
                            onChange={(e) => setCsvText(e.target.value)}
                            placeholder={`user1,pass1,email1@example.com\nuser2,pass2,email2@example.com`}
                            rows={4}
                            className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition-all mb-2"
                          />
                          <button
                            onClick={handleCsvUpload}
                            disabled={uploading || !csvText.trim()}
                            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-xs font-medium transition-all text-white"
                          >
                            {uploading ? "Uploading..." : "Upload"}
                          </button>
                          {csvResult && (
                            <div className={`mt-2 p-2.5 rounded-lg text-xs ${
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
                      {expandedGroup && expandedGroup.accounts && expandedGroup.accounts.length > 0 ? (
                        <table className="w-full">
                          <thead>
                            <tr className="border-b border-gray-800">
                              <th className="text-left px-3 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider">InstaDDR ID</th>
                              <th className="text-left px-3 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
                              <th className="text-left px-3 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider">Added</th>
                              <th className="text-right px-3 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {expandedGroup.accounts.map((account) => (
                              <tr key={account._id} className="border-b border-gray-800/50 hover:bg-gray-800/20">
                                <td className="px-3 py-2.5 text-sm font-mono text-gray-300">{account.instaDdrId}</td>
                                <td className="px-3 py-2.5 text-sm text-gray-400">{account.email}</td>
                                <td className="px-3 py-2.5 text-sm text-gray-600">
                                  {new Date(account.createdAt).toLocaleDateString()}
                                </td>
                                <td className="px-3 py-2.5 text-right">
                                  <button
                                    onClick={() => handleDeleteAccount(account._id)}
                                    className="text-xs text-red-400 hover:text-red-300 transition-colors font-medium"
                                  >
                                    Delete
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <div className="text-center py-4">
                          <p className="text-gray-600 text-sm">No accounts in this group yet.</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
