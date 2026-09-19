' Windowless launcher: starts the harness in the background and opens the control
' panel. Double-click this instead of a .cmd so no console window ever appears.
' (`npm start` remains the foreground variant for watching logs.)
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)

' 0 = hidden window, False = do not wait for it to finish.
shell.CurrentDirectory = root
shell.Run "node """ & root & "\src\serve.mjs"" --no-open", 0, False

' Wait for the control panel to answer before opening a browser at it.
tokenFile = root & "\.dsh-sub\mcp-token.txt"
url = ""
For i = 1 To 90
  WScript.Sleep 1000
  If fso.FileExists(tokenFile) Then
    Set f = fso.OpenTextFile(tokenFile, 1)
    key = Trim(f.ReadAll)
    f.Close
    On Error Resume Next
    Set http = CreateObject("MSXML2.XMLHTTP")
    http.Open "GET", "http://127.0.0.1:3083/setup?key=" & key, False
    http.Send
    If Err.Number = 0 And http.Status = 200 Then
      url = "http://127.0.0.1:3083/setup?key=" & key
      On Error GoTo 0
      Exit For
    End If
    Err.Clear
    On Error GoTo 0
  End If
Next

If url = "" Then
  MsgBox "DSH-Sub-MCP failed to start." & vbCrLf & _
         "See " & root & "\.dsh-sub\web.err.log", 48, "DSH-Sub-MCP"
Else
  shell.Run """" & url & """", 1, False
End If
