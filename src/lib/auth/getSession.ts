import { getServerSession } from "next-auth";
import { authOptions } from "./authOptions";

export async function getAuthSession() {
  const session = await getServerSession(authOptions);
  return session;
}

export async function requireAuth() {
  const session = await getAuthSession();
  if (!session?.user) {
    throw new Error("Unauthorized");
  }
  return session;
}
