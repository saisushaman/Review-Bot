# Keep-alive wrapper for the PR review bot, launched at log-on by the "PRReviewBot"
# scheduled task. Runs `npm start` (tsx src/index.ts) and relaunches it if it exits/crashes
# (e.g. the transient "ENOTFOUND slack.com" Socket Mode drop that took it down on 2026-07-17).
# npm's redirection is handed to cmd so PowerShell does not wrap the bot's stderr as error records.
Set-Location 'C:\dev\pr-review-bot'
while ($true) {
    "[keepalive] $(Get-Date -Format o) starting bot" | Out-File -Append -Encoding utf8 'bot.out.log'
    cmd /c "npm start >> bot.out.log 2>> bot.err.log"
    "[keepalive] $(Get-Date -Format o) bot exited (code $LASTEXITCODE); restarting in 5s" | Out-File -Append -Encoding utf8 'bot.err.log'
    Start-Sleep -Seconds 5
}
