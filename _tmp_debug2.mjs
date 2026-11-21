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
    let text = null;
    try { text = await res.text(); } catch (e) {}
    let json = null;
    try { json = JSON.parse(text || ""); } catch (e) {}
    return { status: res.status, json, text, headers: res.headers };
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

    const email = "ret.curl." + Date.now() + "@example.com";
    const su = await betterAuthPost("/sign-up/email", { email, password: "TempPass123!", name: "Curl User" });
    const id = su.json && su.json.user ? su.json.user.id : null;
    const token = id ? await getJwt(email, "TempPass123!") : null;
    console.log("user:", email, "id:", id, "token:", Boolean(token));

    // Decode JWT to check email claim
    const parts = token.split(".");
    const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payloadB64 + "=".repeat((4 - payloadB64.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    console.log("JWT email:", payload.email, "sub:", payload.sub);

    // Create book
    const b = await api("POST", "/books", {
        title: "Curl Return Book",
        author: "Curl Author",
        category: "Fiction",
        image: "http://example.com/curl.jpg",
        description: "Curl",
        totalCopies: 2,
        availableCopies: 2,
    }, token);
    console.log("create book:", b.status, b.json && b.json.data ? b.json.data._id : b.text);
    const bookId = b.json && b.json.data ? b.json.data._id : null;

    // Borrow
    const br = await api("POST", "/borrows", { bookId }, token);
    console.log("borrow:", br.status, br.json && br.json.data ? br.json.data._id : br.text);
    const borrowId = br.json && br.json.data ? br.json.data._id : null;

    // Check book before return
    const bookBefore = await db.collection("books").findOne({ _id: new ObjectId(bookId) });
    console.log("book before return: avail=", bookBefore.availableCopies, "total=", bookBefore.totalCopies);

    // Delete (return)
    const ret = await api("DELETE", `/borrows/${borrowId}`, null, token);
    console.log("DELETE:", ret.status, "text:", ret.text, "json:", ret.json);

    // Check book after return
    const bookAfter = await db.collection("books").findOne({ _id: new ObjectId(bookId) });
    console.log("book after return: avail=", bookAfter.availableCopies, "total=", bookAfter.totalCopies);

    // Check borrow record
    const borrowAfter = await db.collection("borrows").findOne({ _id: new ObjectId(borrowId) });
    console.log("borrow record after:", borrowAfter ? "EXISTS" : "DELETED");

    await client.close();
}

main().catch(e => { console.error(e); process.exit(1); });
