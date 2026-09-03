# Test TLS fixtures — NON-PRODUCTION credentials, intentionally committed

These self-signed certificates and **private keys are committed on purpose**. They
are **test-only** credentials used exclusively by the Phase 6 TLS tests
(`apps/web/tests/secure-delivery.test.ts`) to stand up a local HTTPS server and
prove the pinned transport's behavior **without weakening production TLS**.

They are NOT used by any application code, are NOT valid for any real domain, and
grant no access to anything. Do not treat them as secrets.

| File | Purpose |
|------|---------|
| `ca.crt` / `ca.key` | Local test root CA that signs the leaf certs below. Tests pass `ca.crt` as the trusted CA so `rejectUnauthorized` stays **on** and genuinely verifies. |
| `leaf.crt` / `leaf.key` | Leaf cert with **SAN: DNS:webhook.test**. Used for hostname-destination tests (socket pinned to 127.0.0.1 while SNI/Host/cert identity = `webhook.test`). |
| `leaf-ip.crt` / `leaf-ip.key` | Leaf cert with **SAN: IP:127.0.0.1**. Used for the IP-literal test (TLS verifies against the IP SAN; SNI is not set to the IP). |

## Regeneration

Generated with OpenSSL (run from this directory; on Git Bash prefix with
`MSYS_NO_PATHCONV=1`):

```sh
# Root CA
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 3650 \
  -subj "/CN=Webhook Test Root CA"

# Leaf for webhook.test (DNS SAN)
openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -subj "/CN=webhook.test"
printf "subjectAltName=DNS:webhook.test\nextendedKeyUsage=serverAuth\n" > san.ext
openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out leaf.crt \
  -days 3650 -extfile san.ext

# Leaf for 127.0.0.1 (IP SAN)
openssl req -newkey rsa:2048 -nodes -keyout leaf-ip.key -out leaf-ip.csr -subj "/CN=127.0.0.1"
printf "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n" > san-ip.ext
openssl x509 -req -in leaf-ip.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out leaf-ip.crt \
  -days 3650 -extfile san-ip.ext

rm -f *.csr *.ext ca.srl
```
