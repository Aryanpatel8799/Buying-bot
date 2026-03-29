"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Job {
  _id: string;
  platform: string;
  paymentMethod: string;
  totalQuantity: number;
  perOrderQuantity: number;
  status: string;
  progress: {
    totalIterations: number;
    completedIterations: number;
    failedIterations: number;
  };
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

const statusBadge: Record<string, string> = {
  completed: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  failed: "bg-red-500/10 text-red-400 border-red-500/20",
  cancelled: "bg-gray-500/10 text-gray-400 border-gray-500/20",
};

export default function HistoryPage() {
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
      if (res.ok) {
        const data = await res.json();
        setJobs(
          data.filter(
            (j: Job) => j.status === "completed" || j.status === "failed" || j.status === "cancelled"
          )
        );
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(jobId: string) {
    if (!confirm("Are you sure you want to delete this job?")) return;
    const res = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
    if (res.ok) fetchJobs();
  }

  if (loading) {
    return <div className="text-gray-500 text-center py-12">Loading...</div>;
  }

  const totalCompleted = jobs.filter((j) => j.status === "completed").length;
  const totalFailed = jobs.filter((j) => j.status === "failed").length;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Job History</h1>
        <p className="text-sm text-gray-500 mt-0.5">Past completed, failed, and cancelled jobs</p>
      </div>

      {/* Stats */}
      {jobs.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="p-4 bg-gray-900 rounded-xl border border-gray-800">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Total</p>
            <p className="text-2xl font-bold mt-1">{jobs.length}</p>
          </div>
          <div className="p-4 bg-gray-900 rounded-xl border border-gray-800">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Completed</p>
            <p className="text-2xl font-bold mt-1 text-emerald-400">{totalCompleted}</p>
          </div>
          <div className="p-4 bg-gray-900 rounded-xl border border-gray-800">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Failed</p>
            <p className="text-2xl font-bold mt-1 text-red-400">{totalFailed}</p>
          </div>
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="text-center py-16 bg-gray-900 rounded-xl border border-gray-800">
          <p className="text-gray-500">No completed jobs yet.</p>
        </div>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-800">
                {["Platform", "Payment", "Succeeded", "Failed", "Status", "Completed", "Actions"].map(
                  (h) => (
                    <th key={h} className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job._id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-4 py-3 text-sm capitalize font-medium">
                    {job.platform}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-400 capitalize">
                    {job.paymentMethod}
                  </td>
                  <td className="px-4 py-3 text-sm text-emerald-400 font-medium">
                    {job.progress.completedIterations}/{job.progress.totalIterations}
                  </td>
                  <td className="px-4 py-3 text-sm text-red-400 font-medium">
                    {job.progress.failedIterations}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2.5 py-1 rounded-lg text-xs font-medium border ${statusBadge[job.status] || ""}`}>
                      {job.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {job.completedAt ? new Date(job.completedAt).toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <Link
                        href={`/dashboard/jobs/${job._id}`}
                        className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 rounded-lg transition-all font-medium border border-gray-700"
                      >
                        Logs
                      </Link>
                      <button
                        onClick={() => handleDelete(job._id)}
                        className="px-3 py-1.5 text-xs bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg transition-all font-medium border border-red-500/20"
                      >
                        Delete
                      </button>
                    </div>
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
