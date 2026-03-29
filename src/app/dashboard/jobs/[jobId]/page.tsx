"use client";

import { useEffect, useState, useRef, use } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

interface Job {
  _id: string;
  platform: string;
  paymentMethod: string;
  productUrl: string;
  products?: { url: string; quantity: number }[];
  totalQuantity: number;
  perOrderQuantity: number;
  intervalSeconds: number;
  status: string;
  progress: {
    totalIterations: number;
    completedIterations: number;
    failedIterations: number;
    currentIteration: number;
  };
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface LogEntry {
  type: string;
  level?: string;
  message?: string;
  iteration?: number;
  status?: string;
}

export default function JobDetailPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = use(params);
  const { status } = useSession();
  const router = useRouter();
  const [job, setJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [otpAlert, setOtpAlert] = useState<{ email: string; iteration: number } | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sseRetryCount = useRef(0);
  const sseRetryTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    if (status === "authenticated") fetchJob();
  }, [status, router, jobId]);

  useEffect(() => {
    if (job?.status === "running") {
      connectSSE();
    }
    return () => {
      eventSourceRef.current?.close();
      if (sseRetryTimer.current) clearTimeout(sseRetryTimer.current);
    };
  }, [job?.status]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  async function fetchJob() {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (res.ok) {
        const data = await res.json();
        setJob(data);
      }
    } finally {
      setLoading(false);
    }

    // Fetch existing logs
    const logsRes = await fetch(`/api/jobs/${jobId}/logs?limit=200`);
    if (logsRes.ok) {
      const data = await logsRes.json();
      setLogs(
        data.logs.reverse().map((l: { level: string; message: string; iteration: number }) => ({
          type: "log",
          level: l.level,
          message: l.message,
          iteration: l.iteration,
        }))
      );
    }
  }

  function connectSSE() {
    eventSourceRef.current?.close();

    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === "state") {
          setJob(msg.job);
        } else if (msg.type === "progress") {
          setJob((prev) =>
            prev
              ? {
                  ...prev,
                  progress: {
                    ...prev.progress,
                    currentIteration: msg.iteration,
                    completedIterations:
                      msg.status === "success"
                        ? prev.progress.completedIterations + 1
                        : prev.progress.completedIterations,
                    failedIterations:
                      msg.status === "failed"
                        ? prev.progress.failedIterations + 1
                        : prev.progress.failedIterations,
                  },
                }
              : prev
          );
          setLogs((prev) => [...prev, msg]);
        } else if (msg.type === "waiting_for_otp") {
          setOtpAlert({ email: msg.email, iteration: msg.iteration });
          setLogs((prev) => [...prev, { type: "log", level: "warn", message: `Waiting for OTP: ${msg.email}`, iteration: msg.iteration }]);
        } else if (msg.type === "log") {
          // Clear OTP alert when login succeeds
          if (msg.message?.includes("Login successful")) {
            setOtpAlert(null);
          }
          setLogs((prev) => [...prev, msg]);
        } else if (msg.type === "done") {
          setOtpAlert(null);
          setJob((prev) => (prev ? { ...prev, status: msg.status } : prev));
          es.close();
        } else if (msg.type === "closed") {
          es.close();
        }
      } catch {
        // Parse error
      }
    };

    es.onopen = () => {
      // Reset retry count on successful connection
      sseRetryCount.current = 0;
    };

    es.onerror = () => {
      es.close();
      // Auto-reconnect if job is still running (max 10 retries)
      if (sseRetryCount.current < 10) {
        sseRetryCount.current++;
        sseRetryTimer.current = setTimeout(() => {
          // Re-check job status before reconnecting
          fetch(`/api/jobs/${jobId}`)
            .then((r) => r.json())
            .then((data) => {
              if (data.status === "running") {
                connectSSE();
              } else {
                setJob(data);
              }
            })
            .catch(() => {});
        }, 3000);
      }
    };
  }

  async function handleStart() {
    await fetch(`/api/jobs/${jobId}/start`, { method: "POST" });
    fetchJob();
  }

  async function handleStop() {
    await fetch(`/api/jobs/${jobId}/stop`, { method: "POST" });
    fetchJob();
  }

  async function handleRerun() {
    const res = await fetch(`/api/jobs/${jobId}/rerun`, { method: "POST" });
    if (res.ok) {
      const newJob = await res.json();
      router.push(`/dashboard/jobs/${newJob._id}`);
    }
  }

  if (loading) {
    return <div className="text-gray-400 text-center py-12">Loading...</div>;
  }

  if (!job) {
    return <div className="text-gray-400 text-center py-12">Job not found</div>;
  }

  const progressPct =
    job.progress.totalIterations > 0
      ? Math.min(
          100,
          Math.round(
            ((job.progress.completedIterations + job.progress.failedIterations) /
              job.progress.totalIterations) *
              100
          )
        )
      : 0;

  const logLevelColors: Record<string, string> = {
    info: "text-blue-400",
    warn: "text-yellow-400",
    error: "text-red-400",
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Job Details</h1>
        <div className="flex gap-2">
          {(job.status === "pending" || job.status === "failed") && (
            <button
              onClick={handleStart}
              className="px-4 py-2 bg-green-700 hover:bg-green-600 rounded-lg text-sm transition-colors"
            >
              Start Job
            </button>
          )}
          {job.status === "running" && (
            <button
              onClick={handleStop}
              className="px-4 py-2 bg-red-700 hover:bg-red-600 rounded-lg text-sm transition-colors"
            >
              Stop Job
            </button>
          )}
          {(job.status === "completed" ||
            job.status === "failed" ||
            job.status === "cancelled") && (
            <button
              onClick={handleRerun}
              className="px-4 py-2 bg-purple-700 hover:bg-purple-600 rounded-lg text-sm transition-colors"
            >
              Rerun Job
            </button>
          )}
        </div>
      </div>

      {/* Job Info */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="p-3 bg-gray-900 rounded-lg border border-gray-800">
          <p className="text-xs text-gray-400">Platform</p>
          <p className="text-sm font-medium capitalize">{job.platform}</p>
        </div>
        <div className="p-3 bg-gray-900 rounded-lg border border-gray-800">
          <p className="text-xs text-gray-400">Payment</p>
          <p className="text-sm font-medium capitalize">{job.paymentMethod}</p>
        </div>
        <div className="p-3 bg-gray-900 rounded-lg border border-gray-800">
          <p className="text-xs text-gray-400">Total Qty</p>
          <p className="text-sm font-medium">{job.totalQuantity.toLocaleString()}</p>
        </div>
        <div className="p-3 bg-gray-900 rounded-lg border border-gray-800">
          <p className="text-xs text-gray-400">Per Order</p>
          <p className="text-sm font-medium">{job.perOrderQuantity}</p>
        </div>
      </div>

      {/* Progress */}
      <div className="mb-6 p-4 bg-gray-900 rounded-xl border border-gray-800">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-400">
            Progress: {job.progress.completedIterations + job.progress.failedIterations} / {job.progress.totalIterations} iterations
          </span>
          <span className="text-sm font-medium">{progressPct}%</span>
        </div>
        <div className="h-3 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${progressPct}%`,
              background:
                job.progress.failedIterations > 0
                  ? "linear-gradient(90deg, #22c55e, #ef4444)"
                  : "#3b82f6",
            }}
          />
        </div>
        <div className="flex gap-4 mt-2 text-xs text-gray-400">
          <span className="text-green-400">
            {job.progress.completedIterations} succeeded
          </span>
          <span className="text-red-400">
            {job.progress.failedIterations} failed
          </span>
          <span>Status: {job.status}</span>
        </div>
      </div>

      {/* OTP Alert */}
      {otpAlert && (
        <div className="mb-6 p-4 bg-amber-500/10 border-2 border-amber-500/40 rounded-xl animate-pulse">
          <div className="flex items-center gap-3">
            <div className="text-2xl">&#128274;</div>
            <div>
              <p className="text-amber-300 font-semibold text-sm">OTP Required — Enter in Browser</p>
              <p className="text-amber-400/80 text-xs mt-0.5">
                Iteration {otpAlert.iteration}: Enter the OTP sent to <span className="font-mono font-medium">{otpAlert.email}</span> in the browser window
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Product URLs */}
      <div className="mb-6 p-3 bg-gray-900 rounded-lg border border-gray-800">
        <p className="text-xs text-gray-400 mb-1">
          {job.products && job.products.length > 1 ? `Products (${job.products.length})` : "Product URL"}
        </p>
        {job.products && job.products.length > 0 ? (
          <div className="space-y-2">
            {job.products.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-16 shrink-0">Qty: {p.quantity}</span>
                <a
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-400 hover:underline break-all"
                >
                  {p.url}
                </a>
              </div>
            ))}
          </div>
        ) : (
          <a
            href={job.productUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-400 hover:underline break-all"
          >
            {job.productUrl}
          </a>
        )}
      </div>

      {/* Live Logs */}
      <div className="bg-gray-900 rounded-xl border border-gray-800">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-medium text-gray-300">
            Logs {job.status === "running" && "(Live)"}
          </h2>
        </div>
        <div className="h-96 overflow-y-auto p-4 font-mono text-xs space-y-1">
          {logs.length === 0 ? (
            <p className="text-gray-500">No logs yet. Start the job to see output.</p>
          ) : (
            logs.map((log, i) => (
              <div key={i} className="flex gap-2">
                {log.iteration && (
                  <span className="text-gray-500 w-8 text-right shrink-0">
                    #{log.iteration}
                  </span>
                )}
                <span className={logLevelColors[log.level || "info"] || "text-gray-400"}>
                  [{log.level?.toUpperCase() || log.type?.toUpperCase()}]
                </span>
                <span className="text-gray-300">
                  {log.message || (log.type === "progress" ? `Iteration ${log.iteration}: ${log.status}` : "")}
                </span>
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
}
