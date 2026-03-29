"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import Link from "next/link";

export default function HomePage() {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") {
      router.push("/dashboard");
    }
  }, [status, router]);

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 text-gray-400">
        Loading...
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-950 px-4">
      <div className="text-center max-w-2xl">
        <h1 className="text-5xl font-bold mb-4 bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
          AutoBuy Platform
        </h1>
        <p className="text-lg text-gray-400 mb-8">
          Automate bulk product purchasing on Amazon and Flipkart. Configure
          payment methods, set quantities, and let the bot handle the rest.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="p-4 bg-gray-900 rounded-xl border border-gray-800">
            <h3 className="font-medium mb-1">Multi-Platform</h3>
            <p className="text-sm text-gray-400">
              Amazon and Flipkart support
            </p>
          </div>
          <div className="p-4 bg-gray-900 rounded-xl border border-gray-800">
            <h3 className="font-medium mb-1">Batch Orders</h3>
            <p className="text-sm text-gray-400">
              Order thousands in automated batches
            </p>
          </div>
          <div className="p-4 bg-gray-900 rounded-xl border border-gray-800">
            <h3 className="font-medium mb-1">Multiple Payments</h3>
            <p className="text-sm text-gray-400">
              Card, Gift Card, and RTGS
            </p>
          </div>
        </div>

        <div className="flex gap-4 justify-center">
          <Link
            href="/login"
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
          >
            Sign In
          </Link>
          <Link
            href="/signup"
            className="px-6 py-3 bg-gray-800 hover:bg-gray-700 text-white font-medium rounded-lg transition-colors border border-gray-700"
          >
            Create Account
          </Link>
        </div>
      </div>
    </div>
  );
}
