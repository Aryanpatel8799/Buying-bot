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
              className="p-4 bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-700 transition-colors flex items-center justify-between"
            >
              <div>
                <h3 className="font-medium text-white">{profile.name}</h3>
                <div className="flex gap-4 mt-1.5 text-xs text-gray-500">
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
              </div>
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
