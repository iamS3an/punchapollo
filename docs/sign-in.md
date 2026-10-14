# Sign-in

The scripts use an Edge profile of their own, kept in
`%LOCALAPPDATA%\punchapollo\edge-profile` and started with remote debugging
on port `9222` whenever a run needs it. It is separate from your everyday Edge.

Every run first uses the session saved in that profile. Nothing below happens
while the session is valid. When the site answers that authentication is
required, `AUTO_SSO` decides what comes next, and the run then retries what it
was doing.

## AUTO_SSO=off: sign in by hand

The sign-in page is opened, the Edge window is brought to the foreground,
and the run waits: 10 minutes for a scheduled run, 15 for
`npm run session:login`. Sign in the way you normally do. Nothing is filled in
for you, and nothing about the sign-in is stored except the session Edge keeps.

A scheduled punch that nobody signs in for is not made and logs
`Login timed out`.

## AUTO_SSO=on: sign in through Microsoft SSO

The run opens the site's external sign-in for `SSO_PROVIDER` and `SSO_DOMAIN`,
which hands over to Microsoft:

- On a computer signed in to Windows with the same work account, Edge usually
  completes the Microsoft sign-in silently, and nothing more is needed.
- If Microsoft asks for the account name, `SSO_ACCOUNT` is filled in.
- If Microsoft asks for the password, the stored password is submitted once.
- If Microsoft asks for a verification code, it is generated from the stored
  TOTP secret. A code is never submitted twice and at most two are tried.
- If a value is not stored, is rejected, or Microsoft shows a page the script
  does not recognize, Edge is brought to the foreground and the run waits for
  manual input, as with `AUTO_SSO=off`.

The password and the TOTP secret are optional; what is missing is simply asked
of you. They are saved under `%LOCALAPPDATA%\punchapollo\`, encrypted with
Windows DPAPI for the current Windows account on this computer, never in the
project. Run `password:set` again whenever the Microsoft password changes.

## Microsoft account setup

The automatic verification code only works if Microsoft asks for a code. Set
this up once at <https://mysignins.microsoft.com/security-info>:

1. Add a sign-in method of the kind "Authenticator app". When the QR code is
   shown, open the "can't scan the QR code" link and copy the secret key; that
   base32 key (or the whole `otpauth://` URI) is what `npm run totp:set` asks
   for. Finish the setup by entering a code; `totp:set` prints the current one.
2. Change the default sign-in method, shown as "the sign-in method used when
   the most advisable one is unavailable" (當最推薦的方法無法使用時，所使用的
   登入方法), to **Authenticator app or hardware token - code**
   (Authenticator 應用程式或硬體 Token - 代碼).

Without step 2 Microsoft keeps offering a push notification or another method
first, the code prompt never appears, and the sign-in waits for manual input.

`npm run session:test` tests `AUTO_SSO` specifically: it signs in from a clean
InPrivate browser with a throwaway profile on port `9223`, where Microsoft
asks for everything, to confirm the stored values and this setup work.

## Security

- Use only the dedicated Edge profile, not your everyday browser profile, and
  treat its directory as a credential.
- The stored password and TOTP secret together are a complete sign-in for the
  Microsoft account. Enter them only through `npm run password:set` and
  `npm run totp:set`; change the password and re-register the authenticator if
  either has been exposed.
- While the dedicated Edge is running, any program on the computer can drive it
  through the debugging port.
- Never commit `punch.conf`, cookies or authentication headers. `punch.conf`
  and `logs/` are ignored by git.
