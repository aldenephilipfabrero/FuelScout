$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$passwordPointer = [IntPtr]::Zero

try {
    $name = (Read-Host 'Admin name').Trim()
    $email = (Read-Host 'Admin email').Trim()
    $securePassword = Read-Host 'Admin password (12 characters minimum)' -AsSecureString

    if (-not $name) {
        throw 'Admin name is required.'
    }
    if ($email -notmatch '^\S+@\S+\.\S+$') {
        throw 'Enter a valid admin email address.'
    }
    if ($securePassword.Length -lt 12) {
        throw 'Admin password must contain at least 12 characters.'
    }

    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $env:ADMIN_NAME = $name
    $env:ADMIN_EMAIL = $email
    $env:ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)

    Push-Location $projectRoot
    try {
        npm run admin:create
        if ($LASTEXITCODE -ne 0) {
            throw 'Admin setup failed. Check the message above and confirm PostgreSQL is configured.'
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    Remove-Item Env:ADMIN_NAME, Env:ADMIN_EMAIL, Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}
