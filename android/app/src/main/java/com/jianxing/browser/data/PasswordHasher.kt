package com.jianxing.browser.data

import org.bouncycastle.crypto.generators.SCrypt
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Electron-compatible scrypt password hashing:
 * format `scrypt$<saltHex>$<hashHex>`, N=16384, r=8, p=1, keylen=64
 */
object PasswordHasher {
    private const val N = 16384
    private const val R = 8
    private const val P = 1
    private const val KEYLEN = 64
    private const val SALT_LEN = 16

    fun hash(password: String): String {
        val salt = ByteArray(SALT_LEN)
        SecureRandom().nextBytes(salt)
        val derived = SCrypt.generate(
            password.toByteArray(Charsets.UTF_8),
            salt,
            N,
            R,
            P,
            KEYLEN
        )
        return "scrypt$${toHex(salt)}$${toHex(derived)}"
    }

    fun verify(password: String, stored: String): Boolean {
        if (stored.isBlank() || !stored.startsWith("scrypt$")) return false
        val parts = stored.split("$")
        if (parts.size != 3) return false
        val salt = fromHex(parts[1]) ?: return false
        val expected = fromHex(parts[2]) ?: return false
        if (expected.isEmpty()) return false
        val actual = SCrypt.generate(
            password.toByteArray(Charsets.UTF_8),
            salt,
            N,
            R,
            P,
            expected.size
        )
        return MessageDigest.isEqual(actual, expected)
    }

    private fun toHex(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it) }

    private fun fromHex(hex: String): ByteArray? {
        if (hex.isEmpty() || hex.length % 2 != 0) return null
        return try {
            ByteArray(hex.length / 2) { i ->
                hex.substring(i * 2, i * 2 + 2).toInt(16).toByte()
            }
        } catch (_: Exception) {
            null
        }
    }
}
