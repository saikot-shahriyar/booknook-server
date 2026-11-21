import { createRemoteJWKSet, jwtVerify } from "jose";

let remoteJWKSet;
let cachedJwksUrl;

/**
 * Returns a cached createRemoteJWKSet instance for the given JWKS URL.
 * Automatically refreshes the JWKS client if the URL changes.
 */
const getRemoteJWKSet = (jwksUrl) => {
    if (!remoteJWKSet || cachedJwksUrl !== jwksUrl) {
        cachedJwksUrl = jwksUrl;
        remoteJWKSet = createRemoteJWKSet(new URL(jwksUrl));
    }
    return remoteJWKSet;
};

/**
 * Express middleware to verify Better Auth JWTs (EdDSA/Ed25519) via remote JWKS.
 *
 * Checks:
 * - Authorization: Bearer <token>
 * - Signature against public keys at BETTER_AUTH_JWKS_URL
 * - Issuer matching BETTER_AUTH_ISSUER
 * - Audience matching BETTER_AUTH_AUDIENCE
 * - Expiration (exp)
 *
 * On success, attaches { id, email, name } to req.user.
 * On failure, responds with 401 and consistent JSON error message.
 */
export const verifyAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || typeof authHeader !== "string") {
            return res.status(401).json({
                success: false,
                message: "Authorization header is required.",
            });
        }

        const [scheme, token] = authHeader.trim().split(/\s+/);

        if (scheme !== "Bearer" || !token) {
            return res.status(401).json({
                success: false,
                message: "Authorization header format must be: Bearer <token>",
            });
        }

        const jwksUrl = process.env.BETTER_AUTH_JWKS_URL || "http://localhost:3000/api/auth/jwks";
        const issuer = process.env.BETTER_AUTH_ISSUER || "http://localhost:3000";
        const audience = process.env.BETTER_AUTH_AUDIENCE || "http://localhost:3000";

        const JWKS = getRemoteJWKSet(jwksUrl);

        const { payload } = await jwtVerify(token, JWKS, {
            issuer,
            audience,
        });

        req.user = {
            id: payload.sub,
            email: payload.email,
            name: payload.name,
        };

        next();
    } catch (error) {
        let message = "Invalid or expired token.";

        if (error.code === "ERR_JWT_EXPIRED") {
            message = "Token has expired.";
        } else if (error.code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
            message = "Token claim validation failed.";
        } else if (error.code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") {
            message = "Token signature verification failed.";
        } else if (error.code === "ERR_JWS_INVALID") {
            message = "Token format is invalid.";
        }

        return res.status(401).json({
            success: false,
            message,
        });
    }
};

export default verifyAuth;
