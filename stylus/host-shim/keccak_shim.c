/*
 * Host-only shim for Windows builds of Stylus crates.
 * stylus-proc links alloy-primitives with the "native-keccak" feature, which expects the Stylus hostio
 * `native_keccak256`. Linux linkers tolerate the undefined symbol in shared objects; MSVC does not.
 * This provides a real Keccak-256 (Keccak-f[1600], 0x01 padding, rate 136) for HOST artifacts only
 * (proc-macro DLLs, native unit tests). On-chain WASM builds use rust-lld and the real Stylus hostio.
 */
typedef unsigned long long u64;
typedef unsigned char u8;
typedef unsigned long long usize;

static const u64 RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL, 0x8000000080008000ULL,
    0x000000000000808bULL, 0x0000000080000001ULL, 0x8000000080008081ULL, 0x8000000000008009ULL,
    0x000000000000008aULL, 0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL, 0x8000000000008003ULL,
    0x8000000000008002ULL, 0x8000000000000080ULL, 0x000000000000800aULL, 0x800000008000000aULL,
    0x8000000080008081ULL, 0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL};
static const int ROTC[24] = {1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44};
static const int PILN[24] = {10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1};

#define ROTL64(x, y) (((x) << (y)) | ((x) >> (64 - (y))))

static void keccakf(u64 st[25]) {
    int i, j, r;
    u64 t, bc[5];
    for (r = 0; r < 24; r++) {
        for (i = 0; i < 5; i++) bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
        for (i = 0; i < 5; i++) {
            t = bc[(i + 4) % 5] ^ ROTL64(bc[(i + 1) % 5], 1);
            for (j = 0; j < 25; j += 5) st[j + i] ^= t;
        }
        t = st[1];
        for (i = 0; i < 24; i++) {
            j = PILN[i];
            bc[0] = st[j];
            st[j] = ROTL64(t, ROTC[i]);
            t = bc[0];
        }
        for (j = 0; j < 25; j += 5) {
            for (i = 0; i < 5; i++) bc[i] = st[j + i];
            for (i = 0; i < 5; i++) st[j + i] ^= (~bc[(i + 1) % 5]) & bc[(i + 2) % 5];
        }
        st[0] ^= RC[r];
    }
}

void native_keccak256(const u8 *in, usize len, u8 *out) {
    u64 st[25];
    u8 *s = (u8 *)st;
    const usize rate = 136;
    usize i;
    for (i = 0; i < 25; i++) st[i] = 0;
    while (len >= rate) {
        for (i = 0; i < rate; i++) s[i] ^= in[i];
        keccakf(st);
        in += rate;
        len -= rate;
    }
    for (i = 0; i < len; i++) s[i] ^= in[i];
    s[len] ^= 0x01;
    s[rate - 1] ^= 0x80;
    keccakf(st);
    for (i = 0; i < 32; i++) out[i] = s[i];
}
