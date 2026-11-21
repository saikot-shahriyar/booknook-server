import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import dns from "node:dns";
import { config } from "dotenv";

config({ path: ".env" });
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const BASE = "http://localhost:5001";
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
    let json = null;
    try { json = await res.json(); } catch (e) {}
    return { status: res.status, json, headers: res.headers };
}

async function getJwt(email, password) {
    const si = await betterAuthPost("/sign-in/email", { email, password });
    const setCookie = si.headers.get("set-cookie") || "";
    const m = setCookie.match(/better-auth.session_token=([^;]+)/);
    if (!m) return null;
    const cookieValue = m[1];
    const tr = await fetch(AUTH + "/api/auth/token", {
        method: "GET",
        headers: { Cookie: `better-auth.session_token=${cookieValue}`, Origin: AUTH },
    });
    const tb = await tr.json();
    return tb.token || null;
}

async function main() {
    await client.connect();
    const db = client.db("booknook");

    // Create user
    const email = "ret.debug." + Date.now() + "@example.com";
    const su = await betterAuthPost("/sign-up/email", { email, password: "TempPass123!", name: "Debug User" });
    console.log("signup:", su.status, su.json && su.json.user ? su.json.user.id : su.json);
    const id = su.json && su.json.user ? su.json.user.id : null;
    const token = id ? await getJwt(email, "TempPass123!") : null;
    console.log("token:", Boolean(token));

    // Create a book
    const b = await api("POST", "/books", {
        title: "Debug Return Book",
        author: "Debug Author",
        category: "Fiction",
        image: "http://example.com/debug.jpg",
        description: "Debug",
        totalCopies: 2,
        availableCopies: 2,
    }, token);
    console.log("create book:", b.status, b.json && b.json.data ? b.json.data._id : b.json);
    const bookId = b.json && b.json.data ? b.json.data._id : null;

    // Borrow it
    const br = await api("POST", "/borrows", { bookId }, token);
    console.log("borrow:", br.status, JSON.stringify(br.json && br.json.data ? br.json.data : br.json));
    const borrowId = br.json && br.json.data ? br.json.data._id : null;
    console.log("borrowId:", borrowId, "typeof:", typeof borrowId);

    // Check the borrow record in DB directly
    const dbBorrow = await db.collection("borrows").findOne({ _id: new ObjectId(borrowId) });
    console.log("db borrow record:", JSON.stringify(dbBorrow));

    // Try DELETE
    const ret = await api("DELETE", `/borrows/${borrowId}`, null, token);
    console.log("DELETE:", ret.status, JSON.stringify(ret.json));

    // Check again
    const dbBorrow2 = await db.collection("borrows").findOne({ _id: new ObjectId(borrowId) });
    console.log("borrow after delete:", dbBorrow2);
    const dbBook = await db.collection("books").findOne({ _id: new ObjectId(bookId) });
    console.log("book after delete:", { availableCopies: dbBook.availableCopies, totalCopies: dbBook.totalCopies });

    await client.close();
}

main().catch(e => { console.error(e); process.exit(1); });
