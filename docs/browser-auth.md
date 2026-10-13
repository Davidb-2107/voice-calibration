# Connexion navigateur en préproduction privée

`startSupabaseCalibrationApi` sert l'interface existante sur `/` et `/calibration.html`. Les seuls assets publics sont le HTML, le client et `/calibration-auth.js`, contenant exclusivement l'URL Supabase et la clé publique validées côté serveur. Leur lecture ne démarre aucun moteur. Toutes les routes métier restent soumises à la vérification du Bearer, du compte et de son appartenance côté serveur.

Le formulaire connecte un compte email/mot de passe existant. Le mot de passe est envoyé directement à Supabase puis effacé du formulaire ; il n'est pas stocké par le client. Les tokens sont conservés dans `sessionStorage`, propre à l'onglet et à l'URL du projet Supabase. Le rechargement conserve la connexion. Avant un appel API, un token proche de son expiration est renouvelé ; les renouvellements concurrents partagent une promesse. Une erreur de session ferme l'accès local, sans réessayer une mutation métier. La déconnexion efface la session locale et demande à Supabase de révoquer les refresh tokens de cette session (`scope=local`).

La déconnexion Supabase ne rend pas nécessairement un JWT déjà émis immédiatement inutilisable : son expiration reste applicable. Voir [sessions Supabase](https://supabase.com/docs/guides/auth/sessions) et [déconnexion](https://supabase.com/docs/guides/auth/signout). Les tokens sont accessibles au JavaScript de même origine ; cette V1 est destinée à la préproduction privée locale, pas à une exposition publique sans revue supplémentaire.

Le parcours de calibration existant conserve son nonce, ses approbations, son autorisation côté serveur et sa quarantaine. Aucun workspace fourni par le navigateur ne remplace l'appartenance résolue par l'API. Aucun appel fournisseur n'est déclenché par la connexion, le rechargement ou le renouvellement de session.

Tests : `test/calibration-browser-session.test.mjs`, `test/calibration-supabase-auth.test.mjs` et parcours réel Chrome à deux comptes. Les comptes doivent être préalablement provisionnés ; ce lot n'ajoute ni inscription ni récupération de mot de passe.
