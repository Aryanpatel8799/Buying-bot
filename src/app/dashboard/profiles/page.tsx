"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

interface Profile {
  _id: string;
  name: string;
  platform: string;
  isLoggedIn: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  gmailAddress: string | null;
  gmailConnectedAt: string | null;
}

export default function ProfilesPage() {
  const { status } = useSession();
  const router = useRouter();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPlatform, setNewPlatform] = useState("both");
  const [creating, setCreating] = useState(false);
  const [setupLoading, setSetupLoading] = useState<string | null>(null);
  const [gmailLoading, setGmailLoading] = useState<string | null>(null);
  const [gmailModalFor, setGmailModalFor] = useState<string | null>(null);
  const [gmailInput, setGmailInput] = useState("");

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    if (status === "authenticated") fetchProfiles();
  }, [status, router]);

  async function fetchProfiles() {
    try {
      const res = await fetch("/api/profiles");
      if (res.ok) setProfiles(await res.json());
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    const res = await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), platform: newPlatform }),
    });
    if (res.ok) {
      setNewName("");
      setShowCreate(false);
      fetchProfiles();
    }
    setCreating(false);
  }

  async function handleSetup(profileId: string) {
    setSetupLoading(profileId);
    const res = await fetch(`/api/profiles/${profileId}/setup`, {
      method: "POST",
    });
    if (res.ok) {
      alert("Chrome launched! Log in manually, then close the browser.");
      fetchProfiles();
    } else {
      const data = await res.json();
      alert(data.error || "Failed to launch Chrome");
    }
    setSetupLoading(null);
  }

  function openGmailModal(profileId: string, current: string | null) {
    setGmailModalFor(profileId);
    setGmailInput(current ?? "");
  }

  async function handleConnectGmail(e: React.FormEvent) {
    e.preventDefault();
    if (!gmailModalFor) return;
    const address = gmailInput.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      alert("Enter a valid Gmail address");
      return;
    }
    setGmailLoading(gmailModalFor);
    const res = await fetch(`/api/profiles/${gmailModalFor}/gmail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gmailAddress: address }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      alert("Gmail address saved. Chrome is open — log in, then close the browser.");
    } else {
      alert(data.error || "Failed to connect Gmail");
    }
    setGmailModalFor(null);
    setGmailInput("");
    setGmailLoading(null);
    fetchProfiles();
  }

  async function handleDisconnectGmail(profileId: string) {
    if (!confirm("Unlink the Gmail address from this profile?")) return;
    setGmailLoading(profileId);
    const res = await fetch(`/api/profiles/${profileId}/gmail`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to disconnect Gmail");
    }
    setGmailLoading(null);
    fetchProfiles();
  }

  if (loading) {
    return <div className="text-gray-500 text-center py-12">Loading...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Chrome Profiles</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage browser profiles for automation</p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className={`px-5 py-2.5 rounded-xl text-sm font-medium transition-all ${
            showCreate
              ? "bg-gray-800 text-gray-300 border border-gray-700"
              : "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/10"
          }`}
        >
          {showCreate ? "Cancel" : "+ New Profile"}
        </button>
      </div>

      {/* Create Form */}
      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="mb-6 p-5 bg-gray-900 rounded-xl border border-gray-800 space-y-4"
        >
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">
                Profile Name
              </label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                placeholder="e.g., Flipkart Account 1"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5 uppercase tracking-wider">
                Platform
              </label>
              <select
                value={newPlatform}
                onChange={(e) => setNewPlatform(e.target.value)}
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500/40 transition-all"
              >
                <option value="both">Both</option>
                <option value="flipkart">Flipkart Only</option>
                <option value="amazon">Amazon Only</option>
              </select>
            </div>
          </div>
          <button
            type="submit"
            disabled={creating}
            className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-sm font-medium transition-all disabled:opacity-50 shadow-lg shadow-emerald-600/10"
          >
            {creating ? "Creating..." : "Create Profile"}
          </button>
        </form>
      )}

      {/* Profiles List */}
      {profiles.length === 0 ? (
        <div className="text-center py-16 bg-gray-900 rounded-xl border border-gray-800">
          <p className="text-gray-500 mb-2">No profiles yet</p>
          <p className="text-sm text-gray-600">
            Create a profile, then click &quot;Setup&quot; to launch Chrome and log in.
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {profiles.map((profile) => (
            <div
              key={profile._id}
              className="p-4 bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-700 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="font-medium text-white">{profile.name}</h3>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-xs text-gray-500">
                    <span className="capitalize">
                      Platform: <span className="text-gray-400">{profile.platform}</span>
                    </span>
                    <span>
                      Status:{" "}
                      <span
                        className={
                          profile.isLoggedIn ? "text-emerald-400" : "text-yellow-400"
                        }
                      >
                        {profile.isLoggedIn ? "Logged In" : "Not Set Up"}
                      </span>
                    </span>
                    {profile.lastUsedAt && (
                      <span>
                        Last used: <span className="text-gray-400">{new Date(profile.lastUsedAt).toLocaleDateString()}</span>
                      </span>
                    )}
                  </div>
                  <div className="mt-2 text-xs">
                    {profile.gmailAddress ? (
                      <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300">
                        <span>&#x2709;</span>
                        Gmail connected: <span className="font-mono">{profile.gmailAddress}</span>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-800 border border-gray-700 text-gray-400">
                        No Gmail linked
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <button
                    onClick={() => handleSetup(profile._id)}
                    disabled={setupLoading === profile._id}
                    className={`px-4 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50 ${
                      profile.isLoggedIn
                        ? "bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700"
                        : "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/10"
                    }`}
                  >
                    {setupLoading === profile._id
                      ? "Launching..."
                      : profile.isLoggedIn
                      ? "Re-login"
                      : "Setup Login"}
                  </button>
                  <div className="flex gap-2">
                    <button
                      onClick={() => openGmailModal(profile._id, profile.gmailAddress)}
                      disabled={gmailLoading === profile._id}
                      className="flex-1 px-4 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50 bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/10"
                    >
                      {profile.gmailAddress ? "Reconnect Gmail" : "Connect Gmail"}
                    </button>
                    {profile.gmailAddress && (
                      <button
                        onClick={() => handleDisconnectGmail(profile._id)}
                        disabled={gmailLoading === profile._id}
                        className="px-3 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-50 bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700"
                        title="Unlink Gmail"
                      >
                        &#x2715;
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Gmail connect modal */}
      {gmailModalFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <form
            onSubmit={handleConnectGmail}
            className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4"
          >
            <div>
              <h2 className="text-lg font-semibold text-white">Connect Gmail</h2>
              <p className="text-xs text-gray-500 mt-1">
                Enter the Gmail address that receives InstaDDR forwards. Chrome
                will open for you to log into Gmail in this profile.
              </p>
            </div>
            <input
              type="email"
              value={gmailInput}
              onChange={(e) => setGmailInput(e.target.value)}
              placeholder="you@gmail.com"
              autoFocus
              required
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-white font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40"
            />
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => { setGmailModalFor(null); setGmailInput(""); }}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-xl text-sm font-medium border border-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={gmailLoading === gmailModalFor}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-medium disabled:opacity-50"
              >
                {gmailLoading === gmailModalFor ? "Opening…" : "Save & Open Gmail"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
