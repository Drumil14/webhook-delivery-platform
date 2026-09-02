import { checkDatabaseConnection } from "@webhook/db";
import { APP_NAME } from "@webhook/shared";

// Always run on request so the database check reflects the live state.
export const dynamic = "force-dynamic";

export default async function Home() {
  const connected = await checkDatabaseConnection();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6">
      <h1 className="text-2xl font-semibold">{APP_NAME}</h1>

      <p className="text-neutral-300">Web application running.</p>

      <p className="text-neutral-300">
        Database:{" "}
        <span className={connected ? "text-green-400" : "text-red-400"}>
          {connected ? "Connected" : "Not connected"}
        </span>
      </p>
    </main>
  );
}
