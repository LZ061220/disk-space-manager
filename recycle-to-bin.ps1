param(
    [Parameter(Mandatory = $true)][string]$TargetPath,
    [switch]$ContentsOnly
)

$ErrorActionPreference = 'Stop'

# Keep diagnostics out of PowerShell's localized, code-page-dependent error
# formatter. The Node host shows its own stable Chinese message on failure.
$ProgressPreference = 'SilentlyContinue'

if (-not (Test-Path -LiteralPath $TargetPath)) {
    throw 'Target path does not exist or was already processed'
}

# Use the Windows/.NET desktop file API. It performs a real SendToRecycleBin
# operation and preserves the original path for Restore, unlike a plain delete.
Add-Type -AssemblyName Microsoft.VisualBasic
$recycleOption = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
$uiOption = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs

function Move-OneToRecycleBin([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer) {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($Path, $uiOption, $recycleOption)
    } else {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($Path, $uiOption, $recycleOption)
    }
    return -not (Test-Path -LiteralPath $Path)
}

function Move-ContentsRecursively([string]$DirectoryPath) {
    $cleaned = 0
    $skipped = 0
    try {
        $children = @(Get-ChildItem -LiteralPath $DirectoryPath -Force -ErrorAction Stop)
    } catch {
        return @{ Cleaned = 0; Skipped = 1 }
    }

    foreach ($child in $children) {
        try {
            if (Move-OneToRecycleBin $child.FullName) {
                $cleaned += 1
                continue
            }
        } catch {
            # A locked directory can still contain removable siblings.
        }

        if ($child.PSIsContainer -and (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
            $nested = Move-ContentsRecursively $child.FullName
            $cleaned += $nested.Cleaned
            $skipped += $nested.Skipped
            try {
                if (Move-OneToRecycleBin $child.FullName) { $cleaned += 1 }
                elseif (Test-Path -LiteralPath $child.FullName) { $skipped += 1 }
            } catch { $skipped += 1 }
        } else {
            $skipped += 1
        }
    }
    return @{ Cleaned = $cleaned; Skipped = $skipped }
}

if ($ContentsOnly) {
    $result = Move-ContentsRecursively $TargetPath
    if ($result.Cleaned -eq 0 -and $result.Skipped -gt 0) {
        throw 'No removable items found; files may be in use'
    }
    Write-Output "Moved $($result.Cleaned) item(s) to Recycle Bin; skipped $($result.Skipped) item(s) in use"
    exit 0
}

if (-not (Move-OneToRecycleBin $TargetPath)) {
    throw 'Original path still exists; Windows did not complete the Recycle Bin move'
}

Write-Output 'Moved to Recycle Bin and verified original path is gone'
