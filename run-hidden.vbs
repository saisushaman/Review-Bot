' Launches the pr-review-bot hidden (no console window). Used by the PRReviewBot scheduled task.
CreateObject("WScript.Shell").Run "cmd /c cd /d C:\dev\pr-review-bot && npm start >> bot.log 2>&1", 0, False
