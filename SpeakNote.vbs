Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\owner\ni-zu\speaknote"
WshShell.Run "node_modules\electron\dist\electron.exe electron\main.js", 0, False
