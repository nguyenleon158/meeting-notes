property appURL : "http://127.0.0.1:8765"

on run
	set sourcePath to POSIX path of (path to me)
	set sourceDirectory to do shell script "/usr/bin/dirname " & quoted form of sourcePath
	if sourceDirectory ends with "/macos" then
		set projectDirectory to do shell script "/usr/bin/dirname " & quoted form of sourceDirectory
	else
		set projectDirectory to sourceDirectory
	end if
	set nodeExecutable to do shell script "/usr/bin/which node"

	if not my serverIsReady() then
		set launchCommand to "cd " & quoted form of projectDirectory & " && /usr/bin/nohup " & quoted form of nodeExecutable & " server.js >> storage/meetnote-server.log 2>&1 < /dev/null &"
		do shell script launchCommand

		repeat 60 times
			delay 0.25
			if my serverIsReady() then exit repeat
		end repeat
	end if

	if my serverIsReady() then
		open location appURL
	else
		display alert "MeetNote không thể khởi động" message "Kiểm tra file storage/meetnote-server.log trong thư mục dự án." as critical
	end if
end run

on serverIsReady()
	try
		do shell script "/usr/bin/curl --fail --silent --max-time 1 " & quoted form of appURL & " >/dev/null"
		return true
	on error
		return false
	end try
end serverIsReady
