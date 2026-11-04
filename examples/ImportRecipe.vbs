Option Explicit

' Read a semicolon-delimited recipe and publish the results.
Sub ImportRecipe()
    Dim fso, input, report, fields, line, count, total
    Dim sourcePath, reportPath

    sourcePath = SmartTags("RecipePath")
    reportPath = "C:\Import\summary.txt"
    Set fso = CreateObject("Scripting.FileSystemObject")

    If Not fso.FileExists(sourcePath) Then
        ShowSystemAlarm "Recipe file not found: " & sourcePath
        Exit Sub
    End If

    Set input = fso.OpenTextFile(sourcePath, 1)
    count = 0
    total = 0
    If Not input.AtEndOfStream Then line = input.ReadLine

    Do Until input.AtEndOfStream
        line = input.ReadLine
        fields = Split(line, ";")
        If UBound(fields) = 1 Then
            If IsNumeric(fields(1)) Then
                count = count + 1
                total = total + CLng(fields(1))
            End If
        End If
    Loop
    input.Close

    Set report = fso.CreateTextFile(reportPath, True)
    report.WriteLine "Records: " & count
    report.WriteLine "Total: " & total
    report.Close

    SmartTags("RecipeRows") = count
    SmartTags("RecipeTotal") = total
    ShowSystemAlarm "Recipe imported: " & count & " rows"
End Sub
