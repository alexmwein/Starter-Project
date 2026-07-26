on workspaceMatches(workspaceName, candidateName)
	if candidateName is workspaceName then return true
	if candidateName starts with (workspaceName & " +") then return true
	return false
end workspaceMatches

on draftConflict(existingDraft)
	set encodedDraft to do shell script "/usr/bin/printf %s " & quoted form of existingDraft & " | /usr/bin/base64 | /usr/bin/tr -d '\\n'"
	return "{\"ok\":false,\"code\":\"draft_conflict\",\"draftBase64\":\"" & encodedDraft & "\"}"
end draftConflict

on getWebArea()
	tell application "System Events"
		tell process "Conductor"
			try
				return UI element 1 of scroll area 1 of group 1 of group 1 of front window
			end try
		end tell
	end tell
	return missing value
end getWebArea

on getSidebarGroup()
	set webArea to getWebArea()
	if webArea is missing value then return missing value
	tell application "System Events"
		try
			set rootElements to UI elements of webArea
			if (count of rootElements) is greater than or equal to 2 then return item 2 of rootElements
		end try
	end tell
	return missing value
end getSidebarGroup

on getMainGroup()
	set webArea to getWebArea()
	if webArea is missing value then return missing value
	tell application "System Events"
		try
			set rootElements to UI elements of webArea
			if (count of rootElements) is greater than or equal to 3 then return item 3 of rootElements
		end try
	end tell
	return missing value
end getMainGroup

on getWorkspaceContainer()
	set sidebarGroup to getSidebarGroup()
	if sidebarGroup is missing value then return missing value
	tell application "System Events"
		set sidebarElements to UI elements of sidebarGroup
		repeat with candidate in sidebarElements
			try
				set candidateChildren to UI elements of candidate
				repeat with childElement in candidateChildren
					try
						if (role of childElement as text) is "AXLink" then return candidate
					end try
				end repeat
			end try
		end repeat
	end tell
	return missing value
end getWorkspaceContainer

on getSessionTabs()
	set mainGroup to getMainGroup()
	if mainGroup is missing value then return {}
	tell application "System Events"
		try
			set mainElements to UI elements of mainGroup
			repeat with candidate in mainElements
				try
					if (role of candidate as text) is "AXTabGroup" then
						set tabGroupChildren to UI elements of candidate
						if (count of tabGroupChildren) is greater than 0 then return UI elements of item 1 of tabGroupChildren
					end if
				end try
			end repeat
		end try
	end tell
	return {}
end getSessionTabs

on getComposerGroup()
	set mainGroup to getMainGroup()
	if mainGroup is missing value then return missing value
	tell application "System Events"
		set mainElements to UI elements of mainGroup
		repeat with candidate in mainElements
			try
				if (description of candidate as text) is "composer" then return candidate
			end try
		end repeat
	end tell
	return missing value
end getComposerGroup

on getTextArea()
	set composerGroup to getComposerGroup()
	if composerGroup is missing value then return missing value
	tell application "System Events"
		try
			set composerElements to UI elements of composerGroup
			repeat with candidate in composerElements
				try
					if (role of candidate as text) is "AXTextArea" then return candidate
				end try
			end repeat
		end try
	end tell
	return missing value
end getTextArea

on commitTextAreaValue(textArea, requestedValue)
	tell application "System Events"
		tell process "Conductor" to set frontmost to true
		set focused of textArea to true
		set value of attribute "AXValue" of textArea to requestedValue
		-- Conductor's composer is controlled by React. Toggling one real key
		-- forces its state to adopt the accessibility value without using the
		-- clipboard or leaving an extra character in the message.
		keystroke "x"
		key code 51
	end tell
	delay 0.1
	considering case
		return (value of textArea as text) is requestedValue
	end considering
end commitTextAreaValue

on clearOwnedDraft(expectedMessage)
	try
		set textArea to getTextArea()
		if textArea is not missing value then
			tell application "System Events"
				set currentValue to value of textArea as text
			end tell
			considering case
				if currentValue is expectedMessage then my commitTextAreaValue(textArea, "")
			end considering
		end if
	end try
end clearOwnedDraft

set operationMode to system attribute "POCKET_OPERATION"

tell application "System Events"
	if UI elements enabled is false then return "{\"ok\":false,\"code\":\"accessibility_disabled\"}"
	if not (exists process "Conductor") then return "{\"ok\":false,\"code\":\"conductor_not_running\"}"
	tell process "Conductor"
		if not (exists front window) then return "{\"ok\":false,\"code\":\"conductor_window_unavailable\"}"
	end tell
end tell

if operationMode is "doctor" then
	set textArea to getTextArea()
	if textArea is missing value then
		return "{\"ok\":false,\"code\":\"composer_unavailable\"}"
	end if
	return "{\"ok\":true,\"code\":\"ready\"}"
end if

set workspaceName to system attribute "POCKET_WORKSPACE_NAME"
set sessionTitle to system attribute "POCKET_SESSION_TITLE"
set sessionOrdinal to (system attribute "POCKET_SESSION_ORDINAL") as integer
set messageText to system attribute "POCKET_MESSAGE"
set replaceDraft to (system attribute "POCKET_REPLACE_DRAFT") is "true"
set expectedDraft to system attribute "POCKET_EXPECTED_DRAFT"

set workspaceContainer to getWorkspaceContainer()
if workspaceContainer is missing value then return "{\"ok\":false,\"code\":\"workspace_list_unavailable\"}"
set workspaceLink to missing value
tell application "System Events"
	set workspaceElements to UI elements of workspaceContainer
	repeat with candidate in workspaceElements
		try
			if (role of candidate as text) is "AXLink" then
				set candidateName to name of candidate as text
				if my workspaceMatches(workspaceName, candidateName) then
					set workspaceLink to candidate
					exit repeat
				end if
			end if
		end try
	end repeat
	if workspaceLink is missing value then return "{\"ok\":false,\"code\":\"workspace_not_visible\"}"
	perform action "AXPress" of workspaceLink
end tell

set sessionFound to false
repeat with waitIndex from 1 to 50
	delay 0.1
	tell application "System Events"
		set matchedCount to 0
		set sessionTabs to my getSessionTabs()
		repeat with candidate in sessionTabs
			try
				set candidateName to name of candidate as text
				if candidateName is ("Close chat " & sessionTitle) then
					set matchedCount to matchedCount + 1
					if matchedCount is sessionOrdinal then
						if (value of candidate as boolean) is false then perform action "AXPress" of candidate
						set sessionFound to true
						exit repeat
					end if
				end if
			end try
		end repeat
	end tell
	if sessionFound then exit repeat
end repeat

if sessionFound is false then return "{\"ok\":false,\"code\":\"session_not_visible\"}"

set textArea to missing value
repeat with waitIndex from 1 to 50
	set textArea to getTextArea()
	if textArea is not missing value then exit repeat
	delay 0.1
end repeat
if textArea is missing value then return "{\"ok\":false,\"code\":\"composer_unavailable\"}"

tell application "System Events"
	set existingDraft to value of textArea as text
	considering case
		if existingDraft is not messageText then
			if replaceDraft is false and existingDraft is not "" then return my draftConflict(existingDraft)
			if replaceDraft is true and existingDraft is not expectedDraft then return my draftConflict(existingDraft)
		end if
	end considering
end tell

if my commitTextAreaValue(textArea, messageText) is false then
	clearOwnedDraft(messageText)
	return "{\"ok\":false,\"code\":\"composer_update_failed\"}"
end if

set sendButton to missing value
repeat with waitIndex from 1 to 40
	tell application "System Events"
		set composerGroup to my getComposerGroup()
		if composerGroup is not missing value then
			set bestX to -1
			set composerElements to UI elements of composerGroup
			repeat with candidate in composerElements
				try
					if (role of candidate as text) is "AXButton" and (enabled of candidate as boolean) is true then
						set buttonPosition to position of candidate
						set buttonX to item 1 of buttonPosition
						if buttonX is greater than bestX then
							set bestX to buttonX
							set sendButton to candidate
						end if
					end if
				end try
			end repeat
		end if
	end tell
	if sendButton is not missing value then exit repeat
	delay 0.1
end repeat

if sendButton is missing value then
	clearOwnedDraft(messageText)
	return "{\"ok\":false,\"code\":\"send_unavailable\"}"
end if

try
	tell application "System Events" to perform action "AXPress" of sendButton
on error
	clearOwnedDraft(messageText)
	return "{\"ok\":false,\"code\":\"send_failed\"}"
end try

repeat with waitIndex from 1 to 40
	delay 0.1
	set currentTextArea to getTextArea()
	if currentTextArea is not missing value then
		tell application "System Events"
			if (value of currentTextArea as text) is "" then
				return "{\"ok\":true,\"code\":\"sent\"}"
			end if
		end tell
	end if
end repeat

return "{\"ok\":false,\"code\":\"send_not_confirmed\"}"
