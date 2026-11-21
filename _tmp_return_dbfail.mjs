import { config } from "dotenv";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import dns from "node:dns";

config({ path: ".env" });
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const BASE = "http://localhost:5000";
const AUTH = "http://localhost:3000";
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true } });

async function api(method, path, body, token) {
    const res = await fetch(BASE + path, {
        method,
        headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (e) {}
    return { status: res.status, json, headers: res.headers };
}

async function betterAuthPost(path, body) {
    const res = await fetch(AUTH + "/api/auth" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: AUTH },
        body: JSON.stringify(body),
    });
    let json = null; try { json = await res.json(); } catch (e) {}
    return { status: res.status, json, headers: res.headers };
}

async function signUp(email, password, name) {
    return betterAuthPost("/sign-up/email", { email, password, name });
}

async function getJwt(email, password) {
    const si = await betterAuthPost("/sign-in/email", { email, password });
    const setCookie = si.headers.get("set-cookie") || "";
    const m = setCookie.match(/better-auth.session_token=([^;]+)/);
    if (!m) return null;
    const tr = await fetch(AUTH + "/api/auth/token", {
        method: "GET",
        headers: { Cookie: `better-auth.session_token=${m[1]}`, Origin: AUTH },
    });
    const tb = await tr.json().catch(() => ({}));
    return tb.token || null;
}

// Goal: safely exercise the 500 ("Failed to process book return.") path of the
// return endpoint against a TEMP book whose availableCopies we corrupt to a
// string type so the guarded $inc/$expr update fails. All data created here is
// temp and cleaned up below.
async function main() {
    await client.connect();
    const db = client.db("booknook");

    const email = "temp.dbfail.user." + Date.now() + "@example.com";
    const password = "TempPass123!";
    const su = await signUp(email, password, "DB Fail User");
    const userId = su.json?.user?.id;
    const token = await getJwt(email, password);
    console.log("user created:", email, "userId:", userId, "JWT:", Boolean(token));

    const mk = await api("POST", "/books", {
        title: "Temp DB Fail Book", author: "Temp DB Fail Author", category: "Fiction",
        image: "http://example.com/tmpdbfail.jpg",
        description: "Temp book for DB-failure-path test",
        totalCopies: 1, availableCopies: 1,
    }, token);
    const bookId = mk.json?.data?._id;
    console.log("book created:", bookId, "status:", mk.status);
    if (!token || !bookId) { console.log("FATAL: setup failed"); await client.close(); process.exit(1); }

    const br = await api("POST", "/borrows", { bookId }, token);
    const borrowId = br.json?.data?._id;
    console.log("borrow created:", borrowId, "status:", br.status);
    if (!borrowId) { console.log("FATAL: borrow failed"); await client.close(); process.exit(1); }

    // Corrupt availableCopies on the TEMP book to a string -> guarded update errors.
    await db.collection("books").updateOne(
        { _id: new ObjectId(bookId) },
        { $set: { availableCopies: "bogus" } }
    );
    console.log("corrupted temp book availableCopies to 'bogus'");

    // Now attempt the return -> expect the DB-failure path (500) with the record kept.
    const del = await api("DELETE", `/borrows/${borrowId}`, null, token);
    const recStill = !!(await db.collection("borrows").findOne({ _id: new ObjectId(borrowId) }));
    const bookState = await db.collection("books").findOne({ _id: new ObjectId(bookId) });
    console.log("DELETE status:", del.status, "body:", JSON.stringify(del.json));
    console.log("borrow record still exists:", recStill);
    console.log("book availableCopies now:", JSON.stringify(bookState && bookState.availableCopies));

    const passed = del.status === 500 && del.json?.success === false && recStill;
    console.log(passed ? "[PASS] dbFailurePath500: 500 returned, borrow record kept" : "[FAIL] dbFailurePath500 (see above)");

    // Cleanup: restore/delete everything temp.
    await db.collection("books").deleteOne({ _id: new ObjectId(bookId) });
    await db.collection("borrows").deleteOne({ _id: new ObjectId(borrowId) });
    if (userId) {
        await db.collection("user").deleteOne({ _id: new ObjectId(userId) });
        await db.collection("session").deleteMany({ userId });
        await db.collection("account").deleteMany({ userId });
    }
    console.log("cleanup done");

    const after = {
        books: await db.collection("books").countDocuments(),
        borrows: await db.collection("borrows").countDocuments(),
        users: await db.collection("user").countDocuments(),
    };
    console.log("counts after cleanup:", JSON.stringify(after));
    await client.close();
    process.exit(passed ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
