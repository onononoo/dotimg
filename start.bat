@echo off
REM Serve "dotimg" locally. ES modules need http://, not file://.
cd /d "%~dp0"
where py >nul 2>nul && (start "" http://localhost:8137 & py -m http.server 8137 & goto :eof)
where python >nul 2>nul && (start "" http://localhost:8137 & python -m http.server 8137 & goto :eof)
where npx >nul 2>nul && (start "" http://localhost:8137 & npx --yes serve -l 8137 . & goto :eof)
echo Need Python or Node installed to serve this folder.
pause
