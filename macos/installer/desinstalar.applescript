-- Desinstalador de Remote Total. Se compila con osacompile en dist/ (no se instala nada aquí).
-- Pide confirmación, cierra Remote Total y su puente, borra la app de /Applications (con permiso de
-- administrador, solo para lo que está ahí), borra la configuración y los registros del usuario,
-- olvida el recibo del instalador y se borra a sí mismo si está en /Applications.

on run
	try
		display dialog "¿Desinstalar Remote Total?" & return & return & "Se cierra la app y su puente, se borra Remote Total de Aplicaciones y se borran su configuración (~/Library/Application Support/Remote Total) y sus registros (~/Library/Logs/Remote Total)." buttons {"Cancelar", "Desinstalar"} default button "Desinstalar" cancel button "Cancelar" with icon caution with title "Desinstalar Remote Total"
	on error
		return
	end try

	set rutaYo to POSIX path of (path to me)
	if rutaYo ends with "/" then set rutaYo to text 1 thru -2 of rutaYo
	set aBorrar to "rm -rf " & quoted form of "/Applications/Remote Total.app"
	if rutaYo starts with "/Applications/" then set aBorrar to aBorrar & " " & quoted form of rutaYo

	try
		-- Cerrar la app (SIGTERM: ella apaga el puente) y, si el puente sigue vivo, SIGKILL.
		do shell script "pkill -TERM -x RemoteTotal >/dev/null 2>&1; sleep 3; pkill -KILL -f 'Remote Total.app/Contents/Resources/node/node' >/dev/null 2>&1; true"
		-- Solo lo que está en /Applications pide permiso de administrador.
		do shell script aBorrar & "; pkgutil --forget do.caribbeandream.remotetotal >/dev/null 2>&1; true" with administrator privileges
		-- Archivos del usuario: sin administrador.
		do shell script "rm -rf \"$HOME/Library/Application Support/Remote Total\" \"$HOME/Library/Logs/Remote Total\"; true"
	on error mensaje number n
		if n is -128 then return
		display dialog "No se pudo desinstalar: " & mensaje buttons {"OK"} default button "OK" with icon stop with title "Desinstalar Remote Total"
		return
	end try

	display dialog "Remote Total se desinstaló." buttons {"OK"} default button "OK" with title "Desinstalar Remote Total"
end run
