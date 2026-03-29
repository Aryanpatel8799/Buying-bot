"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Job {
  _id: string;
  platform: string;
  paymentMethod: string;
  productUrl: string;
  products?: { url: string; quantity: number }[];
  totalQuantity: number;
  perOrderQuantity: number;
  status: string;
  progress: {
    totalIterations: number;
    completedIterations: number;
    failedIterations: number;
    currentIteration: number;
  };
  createdAt: string;
}

const statusConfig: Record<string, { bg: string; text: string; dot: string }> = {
  pending: { bg: "bg-yellow-500/10 border-yellow-500/20", text: "text-yellow-400", dot: "bg-yellow-400" },
  running: { bg: "bg-blue-500/10 border-blue-500/20", text: "text-blue-400", dot: "bg-blue-400" },
  completed: { bg: "bg-emerald-500/10 border-emerald-500/20", text: "text-emerald-400", dot: "bg-emerald-400" },
  failed: { bg: "bg-red-500/10 border-red-500/20", text: "text-red-400", dot: "bg-red-400" },
  cancelled: { bg: "bg-gray-500/10 border-gray-500/20", text: "text-gray-400", dot: "bg-gray-400" },
  paused: { bg: "bg-orange-500/10 border-orange-500/20", text: "text-orange-400", dot: "bg-orange-400" },
};

export default function DashboardPage() {
  const { status } = useSession();
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    if (status === "authenticated") fetchJobs();
  }, [status, router]);

  async function fetchJobs() {
    try {
      const res = await fetch("/api/jobs");
      if (res.ok) setJobs(await res.json());
    } finally {
      setLoading(false);
    }
  }

  async function handleStart(jobId: string) {
    await fetch(`/api/jobs/${jobId}/start`, { method: "POST" });
    fetchJobs();
  }

  async function handleStop(jobId: string) {
    await fetch(`/api/jobs/${jobId}/stop`, { method: "POST" });
    fetchJobs();
  }

  async function handleRerun(jobId: string) {
    const res = await fetch(`/api/jobs/${jobId}/rerun`, { method: "POST" });
    if (res.ok) {
      const newJob = await res.json();
      router.push(`/dashboard/jobs/${newJob._id}`);
    }
  }

  if (status === "loading" || loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        Loading...
      </div>
    );
  }

  const runningJobs = jobs.filter((j) => j.status === "running").length;
  const completedJobs = jobs.filter((j) => j.status === "completed").length;
  const failedJobs = jobs.filter((j) => j.status === "failed").length;

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage your automation jobs</p>
        </div>
        <Link
          href="/dashboard/jobs/new"
          className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl transition-all text-sm font-medium shadow-lg shadow-blue-600/10"
        >
          + New Job
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {[
          { label: "Total Jobs", value: jobs.length, color: "text-white" },
          { label: "Running", value: runningJobs, color: "text-blue-400" },
          { label: "Completed", value: completedJobs, color: "text-emerald-400" },
          { label: "Failed", value: failedJobs, color: "text-red-400" },
        ].map((stat) => (
          <div
            key={stat.label}
            className="p-4 bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-700 transition-colors"
          >
            <p className="text-xs text-gray-500 uppercase tracking-wider">{stat.label}</p>
            <p className={`text-2xl font-bold mt-1 ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Jobs Table */}
      {jobs.length === 0 ? (
        <div className="text-center py-16 bg-gray-900 rounded-xl border border-gray-800">
          <p className="text-gray-500 mb-3">No jobs yet</p>
          <Link
            href="/dashboard/jobs/new"
            className="text-blue-400 hover:text-blue-300 text-sm transition-colors"
          >
            Create your first job
          </Link>
        </div>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800">
                {["Platform", "Payment", "Products", "Progress", "Status", "Actions"].map(
                  (h) => (
                    <th
                      key={h}
                      className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider"
                    >
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const sc = statusConfig[job.status] || statusConfig.pending;
                const progressPct =
                  job.progress.totalIterations > 0
                    ? Math.round(
                        ((job.progress.completedIterations +
                          job.progress.failedIterations) /
                          job.progress.totalIterations) *
                          100
                      )
                    : 0;
                const productCount = job.products?.length || 1;

                return (
                  <tr
                    key={job._id}
                    className="border-b border-gray-800/50 hover:bg-gray-800/30"
                  >
                    <td className="px-4 py-3 text-sm capitalize font-medium">
                      {job.platform}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-400 capitalize">
                      {job.paymentMethod}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-400">
                      {productCount} item{productCount !== 1 ? "s" : ""}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full transition-all duration-500"
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500 w-8 text-right">
                          {progressPct}%
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border ${sc.bg} ${sc.text}`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${sc.dot} ${
                            job.status === "running" ? "animate-pulse-dot" : ""
                          }`}
                        />
                        {job.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        {(job.status === "pending" || job.status === "failed") && (
                          <button
                            onClick={() => handleStart(job._id)}
                            className="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-all font-medium"
                          >
                            Start
                          </button>
                        )}
                        {job.status === "running" && (
                          <button
                            onClick={() => handleStop(job._id)}
                            className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 rounded-lg transition-all font-medium"
                          >
                            Stop
                          </button>
                        )}
                        {["completed", "failed", "cancelled"].includes(job.status) && (
                          <button
                            onClick={() => handleRerun(job._id)}
                            className="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-500 rounded-lg transition-all font-medium"
                          >
                            Rerun
                          </button>
                        )}
                        <Link
                          href={`/dashboard/jobs/${job._id}`}
                          className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 rounded-lg transition-all font-medium border border-gray-700"
                        >
                          View
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
