@echo off
rem Starts the local signing helper on THIS computer (see README.md in this folder).
rem Usage: start-local-signing-helper.cmd <dashboard-origin> <path-to-approval-private.pem>
rem Either value may instead come from APPROVAL_SIGNER_ALLOWED_ORIGINS / APPROVAL_PRIVATE_KEY_PATH.
rem The private key is only read locally by the helper; nothing here prints or copies it.
setlocal
if not "%~1"=="" set "APPROVAL_SIGNER_ALLOWED_ORIGINS=%~1"
if not "%~2"=="" set "APPROVAL_PRIVATE_KEY_PATH=%~2"
node "%~dp0localSigningHelper.js"
if errorlevel 1 pause
endlocal
