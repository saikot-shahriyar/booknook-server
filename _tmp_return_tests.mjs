import { config } from "dotenv";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import dns from "node:dns";

config({ path: ".env" });
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const BASE = "http://localhost:5000";
const AUTH = "http://localhost:3000";
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, { serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true } });

const results = [];
function pass(name, cond, extra) {
    results.push({ name, passed: Boolean(cond) });
    console.log(`[${cond ? "PASS" : "FAIL"}] ${name}` + (extra !== undefined ? " :: " + JSON.stringify(extra) : ""));
}

async function api(method, path, body, token) {
    const res = await fetch(BASE + path, {
        method,
        headers: Object.assign({ "Content-Type": "application/json" }, token ? { Authorization: "Bearer " + token } : {}),
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch (e) { }
    return { status: res.status, json, headers: res.headers };
}

async function betterAuthPost(path, body) {
    const res = await fetch(AUTH + "/api/auth" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: AUTH },
        body: JSON.stringify(body),
    });
    let json = null; try { json = await res.json(); } catch (e) { }
    return { status: res.status, json, headers: res.headers };
}

async function signUp(email, password, name) {
    return betterAuthPost("/sign-up/email", { email, password, name });
}

async function getJwt(email, password) {
    const si = await betterAuthPost("/sign-in/email", { email, password });
    if (si.status !== 200) { console.log("signIn failed:", si.status, JSON.stringify(si.json)); return null; }
    const setCookie = si.headers.get("set-cookie") || "";
    const m = setCookie.match(/better-auth.session_token=([^;]+)/);
    if (!m) { console.log("signIn: no session cookie; status", si.status, JSON.stringify(si.json)); return null; }
    const tr = await fetch(AUTH + "/api/auth/token", {
        method: "GET",
        headers: { Cookie: `better-auth.session_token=${m[1]}`, Origin: AUTH },
    });
    const tb = await tr.json().catch(() => ({}));
    if (!tb.token) { console.log("token endpoint: no token; status", tr.status, JSON.stringify(tb).slice(0, 200)); return null; }
    return tb.token;
}

const bookState = (db, bookId) => db.collection("books").findOne({ _id: new ObjectId(bookId) });
const borrowState = (db, borrowId) => db.collection("borrows").findOne({ _id: new ObjectId(borrowId) });

async function main() {
    await client.connect();
    const db = client.db("booknook");
    const initial = {
        books: await db.collection("books").countDocuments(),
        borrows: await db.collection("borrows").countDocuments(),
        users: await db.collection("user").countDocuments(),
    };
    console.log("DB initial:", JSON.stringify(initial));

    const tracked = { books: [], borrows: [], userIds: [], emails: [] };

    // ---- Create two temp users ----
    const u1email = "temp.return.user1." + Date.now() + "@example.com";
    const u2email = "temp.return.user2." + Date.now() + "@example.com";
    const password = "TempPass123!";
    tracked.emails.push(u1email, u2email);

    const s1 = await signUp(u1email, password, "Return User 1");
    const s2 = await signUp(u2email, password, "Return User 2");
    const u1id = s1.json?.user?.id;
    const u2id = s2.json?.user?.id;
    console.log("signUp statuses:", s1.status, s2.status, "ids:", u1id, u2id);

    const TOKEN1 = await getJwt(u1email, password);
    const TOKEN2 = await getJwt(u2email, password);
    console.log("JWTs obtained:", Boolean(TOKEN1), Boolean(TOKEN2));
    if (!TOKEN1 || !TOKEN2 || !u1id || !u2id) {
        console.log("FATAL: cannot obtain JWTs/user ids; aborting");
        await client.close();
        process.exit(1);
    }
    tracked.userIds.push(u1id, u2id);

    // ---- Create temp books via the real API ----
    async function makeBook(title, total, avail) {
        const r = await api("POST", "/books", {
            title, author: "Temp Author " + title, category: "Fiction",
            image: "http://example.com/" + title + ".jpg",
            description: "Temporary return-endpoint test book: " + title,
            totalCopies: total, availableCopies: avail,
        }, TOKEN1);
        const id = r.json?.data?._id;
        if (r.status === 201 && id) tracked.books.push(id);
        return { status: r.status, id, json: r.json };
    }

    async function borrow(bookId, token) {
        const r = await api("POST", "/borrows", { bookId }, token);
        if (r.status === 201 && r.json?.data?._id) {
            tracked.borrows.push(r.json.data._id);
            return r.json.data;
        }
        return null;
    }

    const B1 = await makeBook("Temp Return Book 1", 3, 3);
    const B2 = await makeBook("Temp Return Book 2", 1, 0);
    const B3 = await makeBook("Temp Return Book 3", 1, 1);
    const B4 = await makeBook("Temp Return Book 4", 1, 1);
    console.log("books created:", B1.id, B2.id, B3.id, B4.id);
    if (!B1.id || !B3.id) { console.log("FATAL: book creation failed"); await client.close(); process.exit(1); }

    // ============ Test 1: Successful return ============
    const br1 = await borrow(B1.id, TOKEN1);
    if (br1) {
        const before = (await bookState(db, B1.id)).availableCopies;
        const del = await api("DELETE", `/borrows/${br1._id}`, null, TOKEN1);
        const after = (await bookState(db, B1.id)).availableCopies;
        const recGone = !(await borrowState(db, br1._id));
        pass("successfulReturn", del.status === 200 && del.json?.success === true && after === before + 1 && recGone,
            { status: del.status, body: del.json, availBefore: before, availAfter: after, borrowDeleted: recGone });
    } else {
        pass("successfulReturn", false, { borrowCreateStatus: "failed" });
    }

    // ============ Test 2: Returning the same borrow record twice ============
    if (br1) {
        const before = (await bookState(db, B1.id)).availableCopies;
        const del2 = await api("DELETE", `/borrows/${br1._id}`, null, TOKEN1);
        const after = (await bookState(db, B1.id)).availableCopies;
        pass("returnSameRecordTwice", del2.status === 404 && del2.json?.success === false && after === before,
            { status: del2.status, body: del2.json, availBefore: before, availAfter: after });
    }

    // ============ Test 3: Invalid borrow ID ============
    const delInv = await api("DELETE", "/borrows/notanobjectid", null, TOKEN1);
    pass("invalidBorrowId", delInv.status === 400 && delInv.json?.success === false,
        { status: delInv.status, body: delInv.json });

    // ============ Test 4: Non-existent borrow ID ============
    const fakeId = new ObjectId().toString();
    const delFake = await api("DELETE", `/borrows/${fakeId}`, null, TOKEN1);
    pass("nonexistentBorrowId", delFake.status === 404 && delFake.json?.success === false,
        { status: delFake.status, body: delFake.json });

    // ============ Test 5: User returning another user's record ============
    const br2 = await borrow(B3.id, TOKEN2); // user2 borrows book B3
    if (br2) {
        const before = (await bookState(db, B3.id)).availableCopies;
        const delCross = await api("DELETE", `/borrows/${br2._id}`, null, TOKEN1); // user1 tries to return it
        const recStill = !!(await borrowState(db, br2._id));
        const after = (await bookState(db, B3.id)).availableCopies;
        pass("userReturnAnotherUsersRecord", delCross.status === 404 && after === before && recStill,
            { status: delCross.status, body: delCross.json, availBefore: before, availAfter: after, recordStillExists: recStill });
        // user2 returns it for real
        const delOk = await api("DELETE", `/borrows/${br2._id}`, null, TOKEN2);
        const afterOk = (await bookState(db, B3.id)).availableCopies;
        const recGone = !(await borrowState(db, br2._id));
        pass("ownerCanReturnAfterOtherUserFailedAttempt", delOk.status === 200 && afterOk === before + 1 && recGone,
            { status: delOk.status, body: delOk.json, availBefore: before, availAfter: afterOk, borrowDeleted: recGone });
    } else {
        pass("userReturnAnotherUsersRecord", false, { borrowCreateStatus: "failed" });
        pass("ownerCanReturnAfterOtherUserFailedAttempt", false, { borrowCreateStatus: "failed" });
    }

    // ============ Test 6: Missing/invalid JWT ============
    const delNoAuth = await api("DELETE", `/borrows/${fakeId}`, null, null);
    pass("missingJwt401", delNoAuth.status === 401 && delNoAuth.json?.success === false,
        { status: delNoAuth.status, body: delNoAuth.json });
    const delBadAuth = await api("DELETE", `/borrows/${fakeId}`, null, "invalid.token.here");
    pass("invalidJwt401", delBadAuth.status === 401 && delBadAuth.json?.success === false,
        { status: delBadAuth.status, body: delBadAuth.json });

    // ============ Test 7: Inventory increases by exactly 1 ============
    const br7 = await borrow(B1.id, TOKEN1);
    if (br7) {
        const before = (await bookState(db, B1.id)).availableCopies;
        const del7 = await api("DELETE", `/borrows/${br7._id}`, null, TOKEN1);
        const after = (await bookState(db, B1.id)).availableCopies;
        pass("inventoryIncreasesByOne", del7.status === 200 && after === before + 1 && after - before === 1,
            { status: del7.status, availBefore: before, availAfter: after });
    } else {
        pass("inventoryIncreasesByOne", false, { borrowCreateStatus: "failed" });
    }

    // ============ Test 8: Inventory never exceeds totalCopies ============
    if (B2.id) {
        await db.collection("books").updateOne({ _id: new ObjectId(B2.id) }, { $set: { availableCopies: 1 } }); // book is at max (total = 1)
        const fakeBorrow = {
            bookId: B2.id,
            bookTitle: "Temp Return Book 2",
            bookImage: "",
            userEmail: u1email,
            userName: "Return User 1",
            userId: u1id,
            borrowDate: new Date().toISOString(),
            returnDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            createdAt: new Date(),
        };
        const ins = await db.collection("borrows").insertOne(fakeBorrow);
        tracked.borrows.push(ins.insertedId.toString());
        const before = (await bookState(db, B2.id)).availableCopies;
        const delCap = await api("DELETE", `/borrows/${ins.insertedId}`, null, TOKEN1);
        const after = (await bookState(db, B2.id)).availableCopies;
        const recStill = !!(await borrowState(db, ins.insertedId));
        pass("inventoryNeverExceedsTotal", delCap.status === 409 && after === before && recStill,
            { status: delCap.status, body: delCap.json, availBefore: before, availAfter: after, recordStillExists: recStill });
        await db.collection("borrows").deleteOne({ _id: ins.insertedId }); // immediate cleanup of the fake borrow
    }

    // ============ Test 9: Concurrent returns of the same borrow record ============
    const br9 = await borrow(B1.id, TOKEN1);
    if (br9) {
        const before = (await bookState(db, B1.id)).availableCopies;
        const [ra, rb] = await Promise.all([
            api("DELETE", `/borrows/${br9._id}`, null, TOKEN1),
            api("DELETE", `/borrows/${br9._id}`, null, TOKEN1),
        ]);
        const after = (await bookState(db, B1.id)).availableCopies;
        const recGone = !(await borrowState(db, br9._id));
        const successes = [ra.status, rb.status].filter((s) => s === 200).length;
        const otherOk = ra.status === 404 || ra.status === 409 || rb.status === 404 || rb.status === 409;
        pass("concurrentSameBorrowRecord", successes === 1 && otherOk && recGone && after === before + 1,
            { statusA: ra.status, statusB: rb.status, bodyA: ra.json, bodyB: rb.json, borrowDeleted: recGone, availBefore: before, availAfter: after });
    } else {
        pass("concurrentSameBorrowRecord", false, { borrowCreateStatus: "failed" });
    }

    // ============ Test 10: Book deleted while borrowed -> 404 and borrow record kept ============
    const br10 = await borrow(B4.id, TOKEN1);
    if (br10) {
        const delBook = await api("DELETE", `/books/${B4.id}`, null, TOKEN1);
        const del10 = await api("DELETE", `/borrows/${br10._id}`, null, TOKEN1);
        const recStill = !!(await borrowState(db, br10._id));
        pass("bookDeletedWhileBorrowed", delBook.status === 200 && del10.status === 404 && recStill,
            { bookDeleteStatus: delBook.status, returnStatus: del10.status, borrowRecordStillExists: recStill });
    } else {
        pass("bookDeletedWhileBorrowed", false, { borrowCreateStatus: "failed" });
    }

    // ============ Cleanup ============
    console.log("\n=== CLEANUP ===");
    if (tracked.borrows.length) {
        const r = await db.collection("borrows").deleteMany({ _id: { $in: tracked.borrows.map((i) => new ObjectId(i)) } });
        console.log("borrows deleted:", r.deletedCount, "of", tracked.borrows.length);
    }
    if (tracked.books.length) {
        const r = await db.collection("books").deleteMany({ _id: { $in: tracked.books.map((i) => new ObjectId(i)) } });
        console.log("books deleted:", r.deletedCount, "of", tracked.books.length);
    }
    if (tracked.userIds.length) {
        const r = await db.collection("user").deleteMany({ _id: { $in: tracked.userIds.map((i) => new ObjectId(i)) } });
        console.log("users deleted:", r.deletedCount);
        await db.collection("session").deleteMany({ userId: { $in: tracked.userIds } });
        await db.collection("account").deleteMany({ userId: { $in: tracked.userIds } });
        const v = await db.collection("verification").deleteMany({ email: { $in: tracked.emails } });
        console.log("verification docs deleted:", v.deletedCount);
    }

    const after = {
        books: await db.collection("books").countDocuments(),
        borrows: await db.collection("borrows").countDocuments(),
        users: await db.collection("user").countDocuments(),
    };
    console.log("counts after:", JSON.stringify(after), "| initial:", JSON.stringify(initial));
    const countsPreserved = after.books === initial.books && after.borrows === initial.borrows && after.users === initial.users;

    // ============ Summary ============
    console.log("\n=== SUMMARY ===");
    const failed = results.filter((r) => !r.passed).length;
    for (const r of results) console.log(`[${r.passed ? "PASS" : "FAIL"}] ${r.name}`);
    console.log(`passed: ${results.length - failed}, failed: ${failed}`);
    console.log("countsPreserved:", countsPreserved);
    console.log("DONE");
    await client.close();
    process.exit(failed === 0 && countsPreserved ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
